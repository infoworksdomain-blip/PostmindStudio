import type { PlatformConnection, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { ConfigurationError, PlatformError } from '../../errors';
import { notifySafely, type NotificationInput, type Notifier } from '../notifications/notifier';
import { platformRequest } from '../platforms/http';
import {
  DEFAULT_GRAPH_VERSION,
  GRAPH_HOST,
  graphErrors,
  type MetaCredentialSource,
  graphProof,
} from '../platforms/meta';
import { META_CHANNEL_PLATFORMS, type MetaChannelPlatform } from '../platforms/meta-credentials';
import { OAUTH_PLATFORMS, type OAuthClient, type OAuthPlatform } from '../platforms/oauth';
import { getAccessToken } from '../platforms/tokens';
import type { DataKeyProvider } from '../crypto/envelope';

// BACKLOG 17.3 — daily platform account-status check (runbooks/platform-account-revocation.md).
// Publishing finds a revoked token only when a post is due; this job finds it first, so the
// owner can reconnect before anything fails. Each active connection is checked at most once per
// STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS (default 24) with the platform's cheapest documented read
// (docs read 2026-09-28):
//   tiktok    GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name
//             https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
//   youtube   GET https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true (1 unit)
//             https://developers.google.com/youtube/v3/docs/channels/list
//   x         GET https://api.x.com/2/users/me
//             https://docs.x.com/x-api/users/get-my-user
//   linkedin  GET https://api.linkedin.com/v2/userinfo
//             https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
//   These are the reads the OAuth clients already make (platforms/oauth.ts fetchAccount), after
//   the usual token refresh (platforms/tokens.ts getAccessToken).
//   facebook  GET graph.facebook.com/{v}/me?fields=id with the Page token Core registered: "/me
//             ... translates to the object ID of the person or Page whose access token is
//             currently being used" — https://developers.facebook.com/docs/graph-api/overview
//   instagram GET graph.facebook.com/{v}/{ig-user-id}/content_publishing_limit?fields=quota_usage,
//             the read the Instagram canary already makes (platforms/canary.ts) and the
//             publishing flow depends on.
//   Meta tokens are Core's (Studio never refreshes them and holds no Meta app token), so Studio
//   does not call debug_token (it needs an app access token); an expired tokenExpiresAt or Graph
//   error 190 is what marks them, exactly as publishing does (platforms/meta-credentials.ts).
//
// Only an authentication failure (HTTP 401, TikTok access_token_invalid, Graph 190, a refused
// refresh — PlatformError class needs_reconnect) marks the connection needs_reconnect, notifies
// its owner (in-app, message key connectionNeedsReconnect / metaConnectionNeedsReconnect) and
// writes audit studio.connection.needs_reconnect. Anything else (timeouts, 5xx, 429, a changed
// response) is recorded as `unreachable` and never changes the state; the next day checks again.
// Rate: at most STUDIO_ACCOUNT_CHECK_BATCH connections per hourly run, STUDIO_ACCOUNT_CHECK_SPACING_MS
// apart, oldest check first; a platform answering 429 is left alone for the rest of the run.

export const ACCOUNT_CHECK_SCHEDULE = '20 * * * *'; // hourly; each connection once per interval
export const CHECK_ACTOR = 'system:account-status-check';
export type CheckOutcome = 'ok' | 'needs_reconnect' | 'unreachable';

export interface AccountCheckConfig {
  intervalMs: number;
  batch: number;
  spacingMs: number;
  graphVersion: string;
  /** Phase 18: META_APP_SECRET, for appsecret_proof on Studio-connected Meta accounts. */
  metaAppSecret?: string;
}

function intSetting(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new ConfigurationError(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

/** STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS (1–168, default 24), _BATCH (1–1000, default 100), _SPACING_MS (0–60000, default 2000). */
export function accountCheckConfig(
  env: Record<string, string | undefined> = process.env,
): AccountCheckConfig {
  return {
    intervalMs: intSetting(env, 'STUDIO_ACCOUNT_CHECK_INTERVAL_HOURS', 24, 1, 168) * 3_600_000,
    batch: intSetting(env, 'STUDIO_ACCOUNT_CHECK_BATCH', 100, 1, 1_000),
    spacingMs: intSetting(env, 'STUDIO_ACCOUNT_CHECK_SPACING_MS', 2_000, 0, 60_000),
    graphVersion: env.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_VERSION,
    ...(env.META_APP_SECRET?.trim() && { metaAppSecret: env.META_APP_SECRET.trim() }),
  };
}

export interface AccountCheckDeps {
  db: PrismaClient;
  keys: DataKeyProvider;
  oauth: (platform: OAuthPlatform) => OAuthClient;
  meta: MetaCredentialSource;
  fetchImpl: typeof fetch;
  audit: (entry: AuditEntry) => void;
  logger: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  notifier?: Notifier;
  config?: AccountCheckConfig;
  /** One organisation only (tests, manual runs); absent = all. */
  organisationId?: string;
}

export interface AccountCheckResult {
  checked: number;
  ok: number;
  needsReconnect: string[];
  unreachable: number;
  /** Connections left for a later run because their platform answered 429 in this one. */
  deferred: number;
}

const isOAuthPlatform = (p: string): p is OAuthPlatform =>
  (OAUTH_PLATFORMS as readonly string[]).includes(p);
const isMetaPlatform = (p: string): p is MetaChannelPlatform =>
  (META_CHANNEL_PLATFORMS as readonly string[]).includes(p);

async function probeMeta(
  deps: AccountCheckDeps,
  connection: PlatformConnection,
  platform: MetaChannelPlatform,
  graphVersion: string,
  metaAppSecret?: string,
): Promise<void> {
  const { accessToken, accountId } = await deps.meta.getCredentials({
    organisationId: connection.organisationId,
    platform,
    platformAccountId: connection.platformAccountId,
  });
  const url = new URL(
    platform === 'facebook'
      ? `${GRAPH_HOST}/${graphVersion}/me?fields=id`
      : `${GRAPH_HOST}/${graphVersion}/${encodeURIComponent(accountId)}/content_publishing_limit?fields=quota_usage`,
  );
  // Phase 18: tokens from Studio's own Meta login carry appsecret_proof (Graph Secure Requests).
  if (metaAppSecret && connection.connectedVia === 'studio')
    url.searchParams.set('appsecret_proof', graphProof(accessToken, metaAppSecret));
  await platformRequest<unknown>(
    url.toString(),
    { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
    { platform, fetchImpl: deps.fetchImpl, timeoutMs: 20_000, ...graphErrors },
  );
}

/** One connection's cheap authenticated read. Throws the platform's error as-is. */
export async function probeConnection(
  deps: AccountCheckDeps,
  connection: PlatformConnection,
  graphVersion: string,
  metaAppSecret?: string,
): Promise<void> {
  const platform = connection.platform;
  if (isMetaPlatform(platform))
    return probeMeta(deps, connection, platform, graphVersion, metaAppSecret);
  if (!isOAuthPlatform(platform))
    throw new PlatformError(platform, 'unknown', `No account check for ${platform}`, false);
  const accessToken = await getAccessToken(
    { db: deps.db, keys: deps.keys, oauth: deps.oauth, now: deps.now },
    connection,
  );
  await deps.oauth(platform).fetchAccount(accessToken);
}

export function classifyCheckError(err: unknown): CheckOutcome {
  return err instanceof PlatformError && err.errorClass === 'needs_reconnect'
    ? 'needs_reconnect'
    : 'unreachable';
}

/** The owner's notification: the app renders the message key in the reader's locale. */
export function reconnectNotification(
  connection: Pick<
    PlatformConnection,
    | 'id'
    | 'organisationId'
    | 'platform'
    | 'platformAccountName'
    | 'connectedByUserId'
    | 'connectedAt'
  > &
    Partial<Pick<PlatformConnection, 'connectedVia'>>,
): NotificationInput {
  // Phase 18: only Meta channels PostMind Core registered are reconnected in PostMind settings;
  // those Studio connected itself (connectedVia 'studio') are reconnected on /connections.
  const meta = isMetaPlatform(connection.platform) && connection.connectedVia !== 'studio';
  const account = connection.platformAccountName;
  return {
    organisationId: connection.organisationId,
    // Core-registered Meta channels name no Studio user: tell the organisation.
    userId: connection.connectedByUserId.startsWith('system:')
      ? null
      : connection.connectedByUserId,
    kind: 'connection_needs_reconnect',
    title: `Reconnect your ${connection.platform} account “${account}”`,
    body: meta
      ? 'Meta no longer accepts Studio’s access to this account. Reconnect it in PostMind settings so scheduled posts can go out.'
      : 'The platform no longer accepts Studio’s access to this account. Reconnect it on the Connections page so scheduled posts can go out.',
    link: '/connections',
    // Once per connection lifetime: a reconnect (new connectedAt) re-arms it.
    dedupeKey: `connection_needs_reconnect:${connection.id}:${connection.connectedAt.getTime()}`,
    message: {
      key: meta ? 'metaConnectionNeedsReconnect' : 'connectionNeedsReconnect',
      params: { account, platform: connection.platform },
    },
  };
}

async function record(
  db: PrismaClient,
  id: string,
  outcome: CheckOutcome,
  at: Date,
): Promise<void> {
  await db.platformConnection.updateMany({
    where: { id },
    data: { statusCheckedAt: at, statusCheckOutcome: outcome },
  });
}

async function markNeedsReconnect(
  deps: AccountCheckDeps,
  connection: PlatformConnection,
  err: unknown,
  at: Date,
): Promise<boolean> {
  // CAS from active; getAccessToken / the Meta source may already have flipped it in this check.
  await deps.db.platformConnection.updateMany({
    where: { id: connection.id, state: 'active' },
    data: { state: 'needs_reconnect' },
  });
  const current = await deps.db.platformConnection.findUnique({
    where: { id: connection.id },
    select: { state: true },
  });
  // Disconnected (revoked) or re-registered while we checked: nothing to report.
  if (current?.state !== 'needs_reconnect') return false;
  await record(deps.db, connection.id, 'needs_reconnect', at);
  deps.audit({
    actorUserId: CHECK_ACTOR,
    organisationId: connection.organisationId,
    action: 'studio.connection.needs_reconnect',
    resource: { type: 'platform_connection', id: connection.id },
    metadata: {
      platform: connection.platform,
      platformAccountId: connection.platformAccountId,
      reason: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
      source: 'account_status_check',
    },
  });
  await notifySafely(deps, reconnectNotification(connection));
  return true;
}

export async function checkPlatformAccounts(deps: AccountCheckDeps): Promise<AccountCheckResult> {
  const config = deps.config ?? accountCheckConfig();
  const due = new Date(deps.now() - config.intervalMs);
  const connections = await deps.db.platformConnection.findMany({
    where: {
      ...(deps.organisationId && { organisationId: deps.organisationId }),
      state: 'active',
      OR: [{ statusCheckedAt: null }, { statusCheckedAt: { lt: due } }],
    },
    orderBy: [{ statusCheckedAt: { sort: 'asc', nulls: 'first' } }, { connectedAt: 'asc' }],
    take: config.batch,
  });
  const result: AccountCheckResult = {
    checked: 0,
    ok: 0,
    needsReconnect: [],
    unreachable: 0,
    deferred: 0,
  };
  const throttled = new Set<string>();
  for (const connection of connections) {
    if (throttled.has(connection.platform)) {
      result.deferred += 1;
      continue;
    }
    if (result.checked > 0 && config.spacingMs > 0) await deps.sleep(config.spacingMs);
    result.checked += 1;
    const log = deps.logger.child({
      connectionId: connection.id,
      organisationId: connection.organisationId,
      platform: connection.platform,
    });
    try {
      await probeConnection(deps, connection, config.graphVersion, config.metaAppSecret);
      await record(deps.db, connection.id, 'ok', new Date(deps.now()));
      result.ok += 1;
      continue;
    } catch (err) {
      const at = new Date(deps.now());
      if (classifyCheckError(err) === 'needs_reconnect') {
        if (await markNeedsReconnect(deps, connection, err, at)) {
          result.needsReconnect.push(connection.id);
          log.warn({ err }, 'platform account needs reconnecting');
        }
        continue;
      }
      // Transient or unexplained: record it, never change the connection's state.
      if (err instanceof PlatformError && err.errorClass === 'rate_limited')
        throttled.add(connection.platform);
      await record(deps.db, connection.id, 'unreachable', at);
      result.unreachable += 1;
      log.warn({ err }, 'platform account check could not complete; state unchanged');
    }
  }
  deps.logger.info(
    {
      checked: result.checked,
      ok: result.ok,
      needsReconnect: result.needsReconnect.length,
      unreachable: result.unreachable,
      deferred: result.deferred,
    },
    'platform account check finished',
  );
  return result;
}
