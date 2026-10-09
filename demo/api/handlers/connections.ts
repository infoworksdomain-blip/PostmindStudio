// Platform connections (services/connections.ts): the organisation-wide list, the OAuth start
// (the demo "authorize URL" is a hash route back to the Connections screen with ?connected=, so
// the real callback notice shows) and disconnect. Phase 18: the demo runs in standalone mode, so
// Instagram and Facebook are connected with Studio's own Facebook login (meta.connect 'studio',
// connectedVia 'studio'): they reconnect and disconnect here like the other platforms.
// 17.3: the daily account-status check records statusCheckedAt / statusCheckOutcome; healthy
// accounts show "Access checked <date>", and X was refused (needs_reconnect, with a notification).
import type { PlatformConnection } from '@/lib/client/types';
import { CONNECTIONS, DEMO_BUSINESS_ID, DEMO_ORG_ID, DEMO_USER_ID } from '../ids';
import { DemoHttpError, route } from '../registry';

export interface DemoConnection extends PlatformConnection {
  organisationId: string;
  connectedByUserId: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LOADED_AT = Date.now();
const iso = (offsetMs: number) => new Date(LOADED_AT + offsetMs).toISOString();

type OAuthPlatform = 'tiktok' | 'youtube' | 'x' | 'linkedin';
const OAUTH_PLATFORMS: OAuthPlatform[] = ['tiktok', 'youtube', 'x', 'linkedin'];

/** The scopes each OAuth client asks for (platforms/oauth.ts). */
const SCOPES: Record<OAuthPlatform, string[]> = {
  tiktok: ['user.info.basic', 'video.publish', 'video.upload'],
  youtube: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ],
  x: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
  linkedin: ['w_member_social', 'w_organization_social', 'r_organization_social'],
};
/** Access-token lifetimes on connect (refresh keeps them rolling). */
const TOKEN_TTL: Record<OAuthPlatform, number> = {
  tiktok: DAY,
  youtube: HOUR,
  x: 2 * HOUR,
  linkedin: 60 * DAY,
};

function conn(
  c: Omit<DemoConnection, 'organisationId' | 'connectedByUserId'> & { connectedByUserId?: string },
): DemoConnection {
  return { organisationId: DEMO_ORG_ID, connectedByUserId: DEMO_USER_ID, ...c };
}

// 26.1: every plan publishes to every connected platform (no channel limit).
const rows: DemoConnection[] = [
  conn({
    id: CONNECTIONS.tiktok.id,
    businessId: DEMO_BUSINESS_ID,
    platform: 'tiktok',
    platformAccountId: CONNECTIONS.tiktok.accountId,
    platformAccountName: CONNECTIONS.tiktok.account,
    accessTokenExpiresAt: iso(18 * HOUR),
    scopes: SCOPES.tiktok,
    state: 'active',
    connectedAt: iso(-150 * DAY),
    statusCheckedAt: iso(-5 * HOUR),
    statusCheckOutcome: 'ok',
    // 22.7: this account sends posts to the TikTok drafts (the Connections card shows the choice).
    tiktokPostMode: 'drafts',
  }),
  conn({
    id: CONNECTIONS.youtube.id,
    businessId: DEMO_BUSINESS_ID,
    platform: 'youtube',
    platformAccountId: CONNECTIONS.youtube.accountId,
    platformAccountName: CONNECTIONS.youtube.account,
    accessTokenExpiresAt: iso(42 * 60_000),
    scopes: SCOPES.youtube,
    state: 'active',
    connectedAt: iso(-110 * DAY),
    statusCheckedAt: iso(-11 * HOUR),
    statusCheckOutcome: 'ok',
  }),
  conn({
    id: CONNECTIONS.linkedin.id,
    businessId: DEMO_BUSINESS_ID,
    platform: 'linkedin',
    platformAccountId: CONNECTIONS.linkedin.accountId,
    platformAccountName: CONNECTIONS.linkedin.account,
    accessTokenExpiresAt: iso(41 * DAY),
    scopes: SCOPES.linkedin,
    state: 'active',
    connectedAt: iso(-19 * DAY),
    // Not checked yet (connected before the check ran for this account): no line shown.
    statusCheckedAt: null,
    statusCheckOutcome: null,
  }),
  conn({
    id: CONNECTIONS.x.id,
    businessId: DEMO_BUSINESS_ID,
    platform: 'x',
    platformAccountId: CONNECTIONS.x.accountId,
    platformAccountName: CONNECTIONS.x.account,
    accessTokenExpiresAt: iso(-6 * DAY),
    scopes: SCOPES.x,
    state: 'needs_reconnect',
    connectedAt: iso(-60 * DAY),
    statusCheckedAt: iso(-7 * HOUR),
    statusCheckOutcome: 'needs_reconnect',
  }),
  // Registered by PostMind Core (organisation-wide Meta channels, read-only in Studio).
  conn({
    id: CONNECTIONS.instagram.id,
    businessId: null,
    platform: 'instagram',
    platformAccountId: CONNECTIONS.instagram.accountId,
    platformAccountName: CONNECTIONS.instagram.account,
    accessTokenExpiresAt: iso(52 * DAY),
    scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
    state: 'active',
    connectedAt: iso(-120 * DAY),
    connectedVia: 'studio',
    statusCheckedAt: iso(-3 * HOUR),
    statusCheckOutcome: 'ok',
  }),
  conn({
    id: CONNECTIONS.facebook.id,
    businessId: null,
    platform: 'facebook',
    platformAccountId: CONNECTIONS.facebook.accountId,
    platformAccountName: CONNECTIONS.facebook.account,
    accessTokenExpiresAt: null,
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
    state: 'active',
    connectedAt: iso(-90 * DAY),
    connectedVia: 'studio',
    // The last check could not reach Facebook (a transient error): recorded, state unchanged.
    statusCheckedAt: iso(-3 * HOUR),
    statusCheckOutcome: 'unreachable',
  }),
  // An old, disconnected TikTok test account (revoked rows stay in the list; the screen hides them).
  conn({
    id: 'conn-tiktok-old',
    businessId: DEMO_BUSINESS_ID,
    platform: 'tiktok',
    platformAccountId: 'tt-1204',
    platformAccountName: '@leedssourdough_test',
    accessTokenExpiresAt: null,
    scopes: SCOPES.tiktok,
    state: 'revoked',
    connectedAt: iso(-210 * DAY),
  }),
];

/** Connections other areas can read (e.g. to pick a publish target). */
export function listConnections(): DemoConnection[] {
  return [...rows]
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))
    .map((c) => ({ ...c, scopes: [...c.scopes] }));
}

route('GET', '/platform-connections', () => ({
  data: listConnections(),
  meta: { connect: 'studio', configured: true },
}));

/** Studio's own Meta login (services/meta-connect.ts): the Pages and linked IG accounts return. */
function completeMetaConnect(): number {
  const fresh = { state: 'active' as const, connectedAt: new Date().toISOString() };
  let count = 0;
  for (const id of [CONNECTIONS.instagram.id, CONNECTIONS.facebook.id]) {
    const i = rows.findIndex((r) => r.id === id);
    const row = rows[i];
    if (!row) continue;
    rows[i] = { ...row, ...fresh, connectedVia: 'studio', connectedByUserId: DEMO_USER_ID };
    count += 1;
  }
  return count;
}

const ACCOUNT: Record<OAuthPlatform, { accountId: string; name: string }> = {
  tiktok: { accountId: CONNECTIONS.tiktok.accountId, name: CONNECTIONS.tiktok.account },
  youtube: { accountId: CONNECTIONS.youtube.accountId, name: CONNECTIONS.youtube.account },
  x: { accountId: CONNECTIONS.x.accountId, name: CONNECTIONS.x.account },
  linkedin: { accountId: CONNECTIONS.linkedin.accountId, name: CONNECTIONS.linkedin.account },
};

/** What the OAuth callback does: upsert on (platform, account), active, fresh token. */
function completeConnect(platform: OAuthPlatform, businessId: string): void {
  const account = ACCOUNT[platform];
  const i = rows.findIndex(
    (r) => r.platform === platform && r.platformAccountId === account.accountId,
  );
  const fresh = {
    businessId,
    state: 'active' as const,
    accessTokenExpiresAt: new Date(Date.now() + TOKEN_TTL[platform]).toISOString(),
    scopes: SCOPES[platform],
    connectedAt: new Date().toISOString(),
    connectedByUserId: DEMO_USER_ID,
  };
  const existing = rows[i];
  if (existing) rows[i] = { ...existing, ...fresh };
  else
    rows.push(
      conn({
        id: `conn-${platform}-${Date.now().toString(36)}`,
        platform,
        platformAccountId: account.accountId,
        platformAccountName: account.name,
        ...fresh,
        // 22.7: a new TikTok connection sends drafts by default.
        ...(platform === 'tiktok' && { tiktokPostMode: 'drafts' as const }),
      }),
    );
}

route('POST', '/platform-connections/oauth-init', ({ body }) => {
  const input = (body ?? {}) as { platform?: unknown; businessId?: unknown };
  const platform = input.platform;
  if (platform === 'meta') {
    const count = completeMetaConnect();
    return { authorizeUrl: `#/connections?connected=meta&count=${count}` };
  }
  if (typeof platform !== 'string' || !OAUTH_PLATFORMS.includes(platform as OAuthPlatform)) {
    throw new DemoHttpError(400, 'validation_error', 'Invalid request body', {
      problems: ['platform: Invalid option: expected one of "tiktok"|"youtube"|"x"|"linkedin"'],
    });
  }
  const businessId = typeof input.businessId === 'string' ? input.businessId : DEMO_BUSINESS_ID;
  completeConnect(platform as OAuthPlatform, businessId);
  return { authorizeUrl: `#/connections?connected=${platform}` };
});

/** 22.7: PATCH { tiktokPostMode } — TikTok connections only (services/connections.ts). */
route('PATCH', '/platform-connections/:id', ({ params, body }) => {
  const i = rows.findIndex((r) => r.id === params.id && r.state !== 'revoked');
  const row = rows[i];
  if (!row) throw new DemoHttpError(404, 'not_found', 'Connection not found');
  const mode = (body as { tiktokPostMode?: unknown } | undefined)?.tiktokPostMode;
  if (mode !== 'direct' && mode !== 'drafts')
    throw new DemoHttpError(400, 'validation_error', 'Invalid request body', {
      problems: ['tiktokPostMode: Invalid option: expected one of "direct"|"drafts"'],
    });
  if (row.platform !== 'tiktok')
    throw new DemoHttpError(
      400,
      'validation_error',
      'Only TikTok connections have a posting preference',
    );
  rows[i] = { ...row, tiktokPostMode: mode };
  return {
    connection: { ...rows[i], scopes: [...row.scopes] },
    uploadGranted: row.scopes.includes('video.upload'),
  };
});

route('DELETE', '/platform-connections/:id', ({ params }) => {
  const i = rows.findIndex((r) => r.id === params.id);
  const row = rows[i];
  if (!row) throw new DemoHttpError(404, 'not_found', 'Connection not found');
  rows[i] = { ...row, state: 'revoked', accessTokenExpiresAt: null };
  return { disconnected: true };
});
