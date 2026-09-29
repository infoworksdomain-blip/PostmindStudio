import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  ConflictError,
  MetaNoAccountsError,
  NotImplementedError,
  ValidationError,
} from '../../errors';
import type { StudioModes } from '../../mode';
import type { TenantContext } from '../../tenant';
import type { DataKeyProvider } from '../crypto/envelope';
import { META_CHANNEL_PLATFORMS } from '../platforms/meta-credentials';
import type { MetaOAuthClient } from '../platforms/meta-oauth';
import type { OAuthPending, OAuthStateStore } from '../platforms/oauth-state';
import { registerMetaChannel } from './meta-channels';

// Phase 18 §2.10 — Studio's own Meta connect (STUDIO_META_CONNECT=studio), the standalone
// replacement for PostMind Core's token push (services/meta-channels.ts keeps that path for
// STUDIO_META_CONNECT=core).
//
//   start     POST /platform-connections/oauth-init {platform:'meta'} → the FLfB dialog URL; the
//             single-use server-side state is bound to (organisation, user, business).
//   complete  the shared OAuth callback: code → short-lived user token → long-lived user token →
//             /me (app-scoped user id) + /me/accounts (Pages, their tokens, linked IG accounts).
//             The user chooses which Pages / IG accounts to share inside Meta's own FLfB dialog
//             (the configuration's asset selection), so every asset returned is connected through
//             registerMetaChannel with connectedVia='studio'. The user token is discarded after
//             use: only the Page tokens (which do not expire) are sealed and stored.
//   deauth    POST /api/meta/deauthorize (signed_request): the user or Page removed the app →
//             its connections are revoked and their tokens wiped.
//   deletion  POST /api/meta/data-deletion (signed_request): the same, plus the Meta-derived
//             fields are cleared; answers { url, confirmation_code } for the status page.

export const META_CONNECT_PLATFORM = 'meta';
const META_ACTOR = 'system:meta-callback';

type Db = Pick<PrismaClient, 'platformConnection'>;

export interface MetaConnectDeps {
  modes: Pick<StudioModes, 'metaConnect'>;
  /** False while the operator has not set META_APP_ID / SECRET / LOGIN_CONFIG_ID. */
  configured: boolean;
  client: () => MetaOAuthClient;
}

/** 409 in core mode (Core owns the Meta login) and 501 until the operator configures the app. */
export function assertMetaConnectAvailable(deps: Omit<MetaConnectDeps, 'client'>): void {
  if (deps.modes.metaConnect !== 'studio')
    throw new ConflictError(
      'Instagram and Facebook accounts are connected in PostMind settings (STUDIO_META_CONNECT=core)',
    );
  if (!deps.configured)
    throw new NotImplementedError(
      'Meta connect needs the operator’s Meta app settings (runbooks/meta-connect.md)',
    );
}

export async function startMetaConnect(
  deps: MetaConnectDeps & { oauthState: OAuthStateStore },
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  input: { businessId: string; returnTo?: string },
): Promise<{ authorizeUrl: string }> {
  assertMetaConnectAvailable(deps);
  const state = await deps.oauthState.create({
    organisationId: tenant.organisationId,
    userId: tenant.userId,
    businessId: input.businessId,
    platform: META_CONNECT_PLATFORM,
    ...(input.returnTo && { returnTo: input.returnTo }),
  });
  return { authorizeUrl: deps.client().authorizeUrl({ state }) };
}

/**
 * The callback carries no API token, so the flow's state names who started it. For Meta the
 * browser's own session must also be that user in that organisation: a state leaked to (or
 * planted on) another signed-in user cannot connect Pages to the wrong organisation.
 */
export function assertSameUser(
  pending: Pick<OAuthPending, 'organisationId' | 'userId' | 'returnTo'>,
  current: Pick<TenantContext, 'organisationId' | 'userId'> | null,
): void {
  if (
    !current ||
    current.userId !== pending.userId ||
    current.organisationId !== pending.organisationId
  )
    throw new ValidationError('This connection was started by a different user; start again', {
      pending: { returnTo: pending.returnTo },
      reason: 'wrong_user',
    });
}

export interface MetaConnectOutcome {
  connectionIds: string[];
  facebook: number;
  instagram: number;
  skippedPages: number;
  metaUserId: string;
  scopes: string[];
}

export async function completeMetaConnect(
  deps: { db: Db; keys: DataKeyProvider; client: MetaOAuthClient },
  pending: OAuthPending,
  code: string,
): Promise<MetaConnectOutcome> {
  const short = await deps.client.exchangeCode(code);
  const long = await deps.client.exchangeLongLived(short.accessToken);
  const [user, scopes, { assets, skippedPages }] = await Promise.all([
    deps.client.fetchUser(long.accessToken),
    deps.client.fetchGrantedScopes(long.accessToken),
    deps.client.fetchAssets(long.accessToken),
  ]);
  if (assets.length === 0)
    throw new MetaNoAccountsError('The Meta login granted no Page Studio can publish to', {
      pending: { returnTo: pending.returnTo },
      skippedPages,
    });
  const connectionIds: string[] = [];
  for (const asset of assets) {
    const { channel } = await registerMetaChannel(
      deps,
      {
        organisationId: pending.organisationId,
        platform: asset.platform,
        platformAccountId: asset.accountId,
        platformAccountName: asset.accountName,
        accessToken: asset.accessToken,
        tokenExpiresAt: null, // Page tokens from a long-lived user token do not expire
        scopes,
        businessId: pending.businessId,
        connectedByUserId: pending.userId,
      },
      { connectedVia: 'studio', metaUserId: user.id },
    );
    connectionIds.push(channel.id);
  }
  return {
    connectionIds,
    facebook: assets.filter((a) => a.platform === 'facebook').length,
    instagram: assets.filter((a) => a.platform === 'instagram').length,
    skippedPages,
    metaUserId: user.id,
    scopes,
  };
}

const REVOKED = {
  state: 'revoked',
  encryptedAccessToken: '',
  encryptedRefreshToken: null,
  accessTokenExpiresAt: null,
} as const;

export interface RevokedConnection {
  id: string;
  organisationId: string;
  platform: string;
}

/** Studio-connected Meta rows a callback names: by Meta user id, or a Page (and its IG) by id. */
async function findTargets(
  db: Db,
  subject: { userId?: string; profileId?: string },
): Promise<RevokedConnection[]> {
  const or = [
    ...(subject.userId ? [{ metaUserId: subject.userId }] : []),
    ...(subject.profileId ? [{ platform: 'facebook', platformAccountId: subject.profileId }] : []),
  ];
  if (or.length === 0) return [];
  return db.platformConnection.findMany({
    where: {
      connectedVia: 'studio',
      platform: { in: [...META_CHANNEL_PLATFORMS] },
      OR: or,
    },
    select: { id: true, organisationId: true, platform: true },
  });
}

/** Deauthorise callback: revoke and wipe tokens. Idempotent (a repeat finds rows already revoked). */
export async function revokeForMetaSubject(
  db: Db,
  subject: { userId?: string; profileId?: string },
): Promise<RevokedConnection[]> {
  const targets = await findTargets(db, subject);
  if (targets.length === 0) return [];
  await db.platformConnection.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: REVOKED,
  });
  return targets;
}

/**
 * Data-deletion callback: revoke, then clear what Studio received from Meta about the user
 * (the Meta user id, granted scopes and the account display name). The Page / IG account id is
 * kept only as the key past publications refer to.
 */
export async function deleteMetaUserData(
  db: Db,
  subject: { userId?: string; profileId?: string },
): Promise<RevokedConnection[]> {
  const targets = await findTargets(db, subject);
  for (const t of targets) {
    const row = await db.platformConnection.findUniqueOrThrow({
      where: { id: t.id },
      select: { platformAccountId: true },
    });
    await db.platformConnection.update({
      where: { id: t.id },
      data: {
        ...REVOKED,
        metaUserId: null,
        scopes: [],
        platformAccountName: row.platformAccountId,
      },
    });
  }
  return targets;
}

// ---- Data-deletion confirmation codes (stateless, HMAC-signed)
//
// Meta asks for "a URL where the user can check the status of their deletion request and an
// alphanumeric confirmation code". Deletion completes inside the callback, so the code itself
// carries everything the status page shows (when, how many connections) and is signed so it
// cannot be forged: 7 base-36 chars of issued-at seconds, 4 of the count, 20 hex of HMAC.

const CODE = /^[0-9a-z]{7}[0-9a-z]{4}[0-9a-f]{20}$/;

function codeMac(secret: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`studio:meta-data-deletion:${body}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
}

export function deletionConfirmationCode(
  secret: string,
  issuedAtMs: number,
  count: number,
): string {
  const body =
    Math.floor(issuedAtMs / 1000)
      .toString(36)
      .padStart(7, '0') +
    Math.min(count, 36 ** 4 - 1)
      .toString(36)
      .padStart(4, '0');
  return body + codeMac(secret, body);
}

export interface DeletionStatus {
  requestedAt: Date;
  connectionsDeleted: number;
}

/** The status a confirmation code stands for, or null when it is malformed or forged. */
export function readDeletionCode(secret: string, code: string): DeletionStatus | null {
  const value = code.trim().toLowerCase();
  if (!CODE.test(value)) return null;
  const body = value.slice(0, 11);
  const mac = Buffer.from(value.slice(11), 'utf8');
  const expected = Buffer.from(codeMac(secret, body), 'utf8');
  if (!timingSafeEqual(mac, expected)) return null;
  return {
    requestedAt: new Date(parseInt(body.slice(0, 7), 36) * 1000),
    connectionsDeleted: parseInt(body.slice(7), 36),
  };
}

export function deletionStatusUrl(appUrl: string, code: string): string {
  const url = new URL('/meta/data-deletion', appUrl);
  url.searchParams.set('code', code);
  return url.toString();
}

export { META_ACTOR };
