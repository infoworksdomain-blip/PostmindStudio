import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dataDeletionRoute from '../../src/app/api/meta/data-deletion/route';
import * as deauthorizeRoute from '../../src/app/api/meta/deauthorize/route';
import * as connectionRoute from '../../src/app/api/studio/platform-connections/[id]/route';
import * as callbackRoute from '../../src/app/api/studio/platform-connections/oauth-callback/route';
import * as initRoute from '../../src/app/api/studio/platform-connections/oauth-init/route';
import * as listRoute from '../../src/app/api/studio/platform-connections/route';
import { studioModes } from '../../src/lib/mode';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import { decryptSecret, tokenContext } from '../../src/lib/studio/crypto/envelope';
import type { MetaOAuthClient } from '../../src/lib/studio/platforms/meta-oauth';
import { signRequest } from '../../src/lib/studio/platforms/meta-signed-request';
import { createMemoryOAuthStateStore } from '../../src/lib/studio/platforms/oauth-state';
import { readDeletionCode } from '../../src/lib/studio/services/meta-connect';
import { APP_URL, call, installApi, rawCall, tenant } from '../helpers/api-harness';

// Phase 18 §2.10 (Track D): Studio's own Facebook Login for Business — state binding (replay,
// expiry, wrong user), code exchange and Page / IG listing against a mocked Graph client, sealed
// Page tokens, disconnect, and the signed deauthorise / data-deletion callbacks.

const hasDb = Boolean(process.env.DATABASE_URL);
const APP_SECRET = 'meta-app-secret-under-test';

function fakeMeta(overrides: Partial<MetaOAuthClient> = {}): MetaOAuthClient {
  return {
    graphVersion: 'v26.0',
    authorizeUrl: ({ state }) =>
      `https://www.facebook.com/v26.0/dialog/oauth?config_id=cfg&state=${state}`,
    exchangeCode: vi.fn(async (code: string) => ({ accessToken: `short-${code}` })),
    exchangeLongLived: vi.fn(async () => ({ accessToken: 'long-user-token' })),
    fetchUser: vi.fn(async () => ({ id: '10001', name: 'Ann' })),
    fetchGrantedScopes: vi.fn(async () => ['pages_manage_posts', 'instagram_content_publish']),
    fetchAssets: vi.fn(async () => ({
      skippedPages: 1,
      assets: [
        {
          platform: 'facebook' as const,
          accountId: '201',
          accountName: 'Leeds Sourdough',
          accessToken: 'page-token-201',
          pageId: '201',
        },
        {
          platform: 'instagram' as const,
          accountId: '17841400000000001',
          accountName: '@leedssourdough',
          accessToken: 'page-token-201',
          pageId: '201',
        },
      ],
    })),
    ...overrides,
  };
}

describe.skipIf(!hasDb)('Meta connect (standalone)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p18-meta-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    colleague: tenant(org, undefined, 'user-2'),
    reader: tenant(org, ['studio:project:read']),
  };
  let deps: ApiDeps;
  let meta: MetaOAuthClient;
  let clock = Date.now();

  const install = (extra: Partial<ApiDeps> = {}) => {
    const api = installApi(db, tokens);
    meta = fakeMeta();
    deps = {
      ...api.deps,
      modes: studioModes({}),
      oauthState: createMemoryOAuthStateStore(() => clock),
      metaConnect: { modes: { metaConnect: 'studio' }, configured: true, client: () => meta },
      ...extra,
    };
    setApiDeps(deps);
  };

  beforeEach(() => {
    clock = Date.now();
    install();
    vi.stubEnv('META_APP_SECRET', APP_SECRET);
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const init = (token = 'owner', body: Record<string, unknown> = {}) =>
    call(initRoute.POST, {
      method: 'POST',
      path: '/api/studio/platform-connections/oauth-init',
      token,
      body: { platform: 'meta', businessId: 'biz-1', returnTo: `${APP_URL}/connections`, ...body },
    });
  const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';
  const callback = (query: string, token?: string) =>
    rawCall(callbackRoute.GET as never, {
      path: `/api/studio/platform-connections/oauth-callback?${query}`,
      token,
    });
  const metaRows = () =>
    db.platformConnection.findMany({
      where: { organisationId: org, platform: { in: ['facebook', 'instagram'] } },
      orderBy: { platform: 'asc' },
    });

  it('connects the granted Page and its Instagram account with sealed Page tokens', async () => {
    const started = await init();
    expect(started.status).toBe(200);
    const url = started.json.authorizeUrl as string;
    expect(url).toContain('config_id=cfg');
    const state = stateOf(url);

    const res = await callback(`code=abc&state=${state}`, 'owner');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_URL}/connections?connected=meta&count=2`);
    expect(meta.exchangeCode).toHaveBeenCalledWith('abc');
    expect(meta.exchangeLongLived).toHaveBeenCalledWith('short-abc');
    expect(meta.fetchAssets).toHaveBeenCalledWith('long-user-token');

    const rows = await metaRows();
    expect(
      rows.map((r) => [r.platform, r.platformAccountId, r.connectedVia, r.metaUserId]),
    ).toEqual([
      ['facebook', '201', 'studio', '10001'],
      ['instagram', '17841400000000001', 'studio', '10001'],
    ]);
    for (const row of rows) {
      expect(row.encryptedAccessToken).not.toContain('page-token');
      expect(row.accessTokenExpiresAt).toBeNull();
      expect(row.businessId).toBe('biz-1');
      expect(row.connectedByUserId).toBe('user-1');
      expect(row.scopes).toEqual(['pages_manage_posts', 'instagram_content_publish']);
      const token = await decryptSecret(
        deps.publishing.keys,
        row.encryptedAccessToken,
        tokenContext({ organisationId: org, platform: row.platform, kind: 'access' }),
      );
      expect(token).toBe('page-token-201');
    }
    // The long-lived user token is never stored.
    const all = JSON.stringify(rows);
    expect(all).not.toContain('long-user-token');

    const listed = await call(listRoute.GET, {
      path: '/api/studio/platform-connections',
      token: 'owner',
    });
    expect(listed.json.meta).toEqual({ connect: 'studio', configured: true });
  });

  it('is single use: a replayed state is refused', async () => {
    const state = stateOf((await init()).json.authorizeUrl as string);
    expect((await callback(`code=a&state=${state}`, 'owner')).status).toBe(302);
    const replay = await callback(`code=a&state=${state}`, 'owner');
    expect(replay.status).toBe(400);
  });

  it('expires after 10 minutes', async () => {
    const state = stateOf((await init()).json.authorizeUrl as string);
    clock += 10 * 60 * 1000 + 1;
    expect((await callback(`code=a&state=${state}`, 'owner')).status).toBe(400);
    expect(meta.exchangeCode).not.toHaveBeenCalled();
  });

  it('is bound to the user who started it: another session or none is refused', async () => {
    const state = stateOf((await init()).json.authorizeUrl as string);
    const wrong = await callback(`code=a&state=${state}`, 'colleague');
    expect(wrong.status).toBe(302);
    expect(wrong.headers.get('location')).toBe(
      `${APP_URL}/connections?connection_error=wrong_user`,
    );
    expect(meta.exchangeCode).not.toHaveBeenCalled();

    const state2 = stateOf((await init()).json.authorizeUrl as string);
    const anonymous = await callback(`code=a&state=${state2}`);
    expect(anonymous.headers.get('location')).toContain('connection_error=wrong_user');
  });

  it('reports a login that granted no publishable Page', async () => {
    install();
    meta.fetchAssets = vi.fn(async () => ({ assets: [], skippedPages: 2 }));
    const state = stateOf((await init()).json.authorizeUrl as string);
    const res = await callback(`code=a&state=${state}`, 'owner');
    expect(res.headers.get('location')).toBe(
      `${APP_URL}/connections?connection_error=meta_no_accounts`,
    );
  });

  it('passes a declined dialog back to the screen', async () => {
    const state = stateOf((await init()).json.authorizeUrl as string);
    const res = await callback(
      `error=access_denied&error_reason=user_denied&state=${state}`,
      'owner',
    );
    expect(res.headers.get('location')).toContain('connection_error=validation_error');
  });

  it('needs connections:manage, 409s in core mode and 501s until configured', async () => {
    expect((await init('reader')).status).toBe(403);
    install({
      metaConnect: { modes: { metaConnect: 'core' }, configured: false, client: () => meta },
    });
    expect((await init()).status).toBe(409);
    install({
      metaConnect: { modes: { metaConnect: 'studio' }, configured: false, client: () => meta },
    });
    const pending = await init();
    expect(pending.status).toBe(501);
    const listed = await call(listRoute.GET, {
      path: '/api/studio/platform-connections',
      token: 'owner',
    });
    expect(listed.json.meta).toEqual({ connect: 'studio', configured: false });
  });

  it('disconnects a Studio-connected Meta account here, but not a Core-registered one', async () => {
    const state = stateOf((await init()).json.authorizeUrl as string);
    await callback(`code=a&state=${state}`, 'owner');
    const [facebook] = await metaRows();
    const del = await call(connectionRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/platform-connections/${facebook!.id}`,
      token: 'owner',
      params: { id: facebook!.id },
    });
    expect(del.status).toBe(200);
    const after = await db.platformConnection.findUniqueOrThrow({ where: { id: facebook!.id } });
    expect(after).toMatchObject({ state: 'revoked', encryptedAccessToken: '' });

    const coreRow = await db.platformConnection.create({
      data: {
        organisationId: org,
        platform: 'instagram',
        platformAccountId: '555',
        platformAccountName: '@core',
        encryptedAccessToken: 'sealed',
        scopes: [],
        state: 'active',
        connectedByUserId: 'system:postmind-core',
        connectedVia: 'core',
      },
    });
    const refused = await call(connectionRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/platform-connections/${coreRow.id}`,
      token: 'owner',
      params: { id: coreRow.id },
    });
    expect(refused.status).toBe(409);
  });

  describe('signed callbacks', () => {
    const post = (route: typeof deauthorizeRoute, body: string) =>
      route.POST(
        new Request(`${APP_URL}/api/meta/x`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      );
    const signed = (payload: Record<string, unknown>, secret = APP_SECRET) =>
      `signed_request=${encodeURIComponent(signRequest({ algorithm: 'HMAC-SHA256', ...payload }, secret))}`;

    async function connectFresh(metaUserId: string) {
      install();
      meta.fetchUser = vi.fn(async () => ({ id: metaUserId, name: 'U' }));
      const state = stateOf((await init()).json.authorizeUrl as string);
      await callback(`code=a&state=${state}`, 'owner');
    }

    it('deauthorize: a valid signed_request revokes that Meta user’s connections', async () => {
      await connectFresh('20002');
      const res = await post(deauthorizeRoute, signed({ user_id: '20002' }));
      expect(res.status).toBe(200);
      const rows = await db.platformConnection.findMany({ where: { metaUserId: '20002' } });
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({ state: 'revoked', encryptedAccessToken: '' });
    });

    it('deauthorize: a Page removal (profile_id) revokes that Page', async () => {
      await connectFresh('20003');
      await post(deauthorizeRoute, signed({ user_id: 0, profile_id: '201' }));
      const page = await db.platformConnection.findFirstOrThrow({
        where: { organisationId: org, platform: 'facebook', platformAccountId: '201' },
      });
      expect(page.state).toBe('revoked');
    });

    it('rejects an invalid signature and touches nothing', async () => {
      await connectFresh('20004');
      const res = await post(deauthorizeRoute, signed({ user_id: '20004' }, 'wrong-secret'));
      expect(res.status).toBe(401);
      const rows = await db.platformConnection.findMany({ where: { metaUserId: '20004' } });
      expect(rows.every((r) => r.state === 'active')).toBe(true);
      expect((await post(deauthorizeRoute, 'signed_request=garbage')).status).toBe(400);
    });

    it('data-deletion: wipes the user’s data and answers a verifiable status URL and code', async () => {
      await connectFresh('20005');
      const res = await post(dataDeletionRoute, signed({ user_id: '20005' }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string; confirmation_code: string };
      expect(body.confirmation_code).toMatch(/^[0-9a-z]+$/);
      expect(body.url).toBe(`${APP_URL}/meta/data-deletion?code=${body.confirmation_code}`);
      expect(readDeletionCode(APP_SECRET, body.confirmation_code)?.connectionsDeleted).toBe(2);
      const rows = await db.platformConnection.findMany({
        where: { organisationId: org, platformAccountId: { in: ['201', '17841400000000001'] } },
      });
      for (const row of rows) {
        expect(row).toMatchObject({ state: 'revoked', encryptedAccessToken: '', metaUserId: null });
        expect(row.scopes).toEqual([]);
        expect(row.platformAccountName).toBe(row.platformAccountId);
      }
    });

    it('answers 404 when Studio does not own the Meta login (core mode or no secret)', async () => {
      install({ modes: studioModes({ STUDIO_MODE: 'core' }) });
      expect((await post(deauthorizeRoute, signed({ user_id: '1' }))).status).toBe(404);
      install();
      vi.stubEnv('META_APP_SECRET', '');
      expect((await post(dataDeletionRoute, signed({ user_id: '1' }))).status).toBe(404);
    });
  });
});
