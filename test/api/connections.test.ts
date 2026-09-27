import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as connectionRoute from '../../src/app/api/studio/platform-connections/[id]/route';
import * as callbackRoute from '../../src/app/api/studio/platform-connections/oauth-callback/route';
import * as initRoute from '../../src/app/api/studio/platform-connections/oauth-init/route';
import * as listRoute from '../../src/app/api/studio/platform-connections/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { decryptSecret, tokenContext } from '../../src/lib/studio/crypto/envelope';
import type { OAuthClient, OAuthPlatform } from '../../src/lib/studio/platforms/oauth';
import { APP_URL, call, installApi, rawCall, tenant } from '../helpers/api-harness';

// BACKLOG 5.8: OAuth connect / list / disconnect for Studio-owned platform connections.

const hasDb = Boolean(process.env.DATABASE_URL);

function fakeClient(platform: OAuthPlatform, usesPkce = false): OAuthClient {
  return {
    platform,
    usesPkce,
    authorizeUrl: ({ state, codeChallenge }) =>
      `https://auth.invalid/${platform}?state=${state}${codeChallenge ? `&cc=${codeChallenge}` : ''}`,
    exchangeCode: vi.fn(async ({ code }) => ({
      accessToken: `access-for-${code}`,
      refreshToken: `refresh-for-${code}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['video.publish'],
    })),
    refresh: vi.fn(),
    fetchAccount: vi.fn(async () => ({ id: `${platform}-acct-1`, name: 'Leeds Sourdough' })),
  };
}

describe.skipIf(!hasDb)('platform connections API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-conn-${randomUUID()}`;
  const tokens = {
    owner: tenant(org),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(`api-conn-other-${randomUUID()}`),
  };
  let api: ReturnType<typeof installApi>;

  beforeEach(() => {
    api = installApi(db, tokens);
    api.oauthClients.set('tiktok', fakeClient('tiktok'));
    api.oauthClients.set('x', fakeClient('x', true));
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.platformConnection.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  const init = (body: unknown, token = 'owner') =>
    call(initRoute.POST, { method: 'POST', token, body });
  const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get('state') ?? '';
  const callback = (query: string) =>
    rawCall(callbackRoute.GET as never, {
      path: `/api/studio/platform-connections/oauth-callback?${query}`,
    });

  it('connects: init → callback stores encrypted tokens, then list and disconnect', async () => {
    const started = await init({
      platform: 'tiktok',
      businessId: 'biz-1',
      returnTo: `${APP_URL}/settings/connections`,
    });
    expect(started.status).toBe(200);
    const authorizeUrl = started.json.authorizeUrl as string;
    const state = stateOf(authorizeUrl);
    expect(state.length).toBeGreaterThan(20);

    const res = await callback(`code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/connections?connected=tiktok`);

    const row = await db.platformConnection.findFirstOrThrow({
      where: { organisationId: org, platform: 'tiktok' },
    });
    expect(row.state).toBe('active');
    expect(row.businessId).toBe('biz-1');
    expect(row.encryptedAccessToken).not.toContain('access-for-abc');
    const ctx = tokenContext({ organisationId: org, platform: 'tiktok', kind: 'access' });
    expect(await decryptSecret(api.publishing.keys, row.encryptedAccessToken, ctx)).toBe(
      'access-for-abc',
    );
    expect(api.audits.map((a) => a.action)).toContain('studio.connection.connected');

    // State is single-use.
    const replay = await callback(`code=abc&state=${state}`);
    expect(replay.status).toBe(400);

    const listed = await call(listRoute.GET, { token: 'reader' });
    expect(listed.status).toBe(200);
    const data = listed.json.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty('encryptedAccessToken');
    expect(data[0]).not.toHaveProperty('encryptedRefreshToken');
    expect((await call(listRoute.GET, { token: 'stranger' })).json.data).toEqual([]);

    expect(
      (
        await call(connectionRoute.DELETE, {
          method: 'DELETE',
          token: 'stranger',
          params: { id: row.id },
        })
      ).status,
    ).toBe(404);
    const gone = await call(connectionRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id: row.id },
    });
    expect(gone.status).toBe(200);
    const revoked = await db.platformConnection.findUniqueOrThrow({ where: { id: row.id } });
    expect(revoked.state).toBe('revoked');
    expect(revoked.encryptedAccessToken).toBe('');
    expect(revoked.encryptedRefreshToken).toBeNull();
  });

  it('uses PKCE for X and passes the verifier to the token exchange', async () => {
    const started = await init({ platform: 'x', businessId: 'biz-1' });
    const authorizeUrl = new URL(started.json.authorizeUrl as string);
    expect(authorizeUrl.searchParams.get('cc')).toBeTruthy();
    const res = await callback(`code=xyz&state=${authorizeUrl.searchParams.get('state')}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, platform: 'x' });
    const client = api.oauthClients.get('x');
    expect(client?.exchangeCode).toHaveBeenCalledWith({
      code: 'xyz',
      codeVerifier: expect.any(String),
    });
  });

  it('rejects off-origin returnTo, missing capability, unknown state and platform errors', async () => {
    expect(
      (await init({ platform: 'tiktok', businessId: 'b', returnTo: 'https://evil.example/x' }))
        .status,
    ).toBe(400);
    expect((await init({ platform: 'tiktok', businessId: 'b' }, 'reader')).status).toBe(403);
    expect((await init({ platform: 'instagram', businessId: 'b' })).status).toBe(400);
    expect((await callback('code=abc&state=nope')).status).toBe(400);
    expect((await callback('code=abc')).status).toBe(400);

    const started = await init({
      platform: 'tiktok',
      businessId: 'b',
      returnTo: `${APP_URL}/settings`,
    });
    const denied = await callback(
      `error=access_denied&state=${stateOf(started.json.authorizeUrl as string)}`,
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe(
      `${APP_URL}/settings?connection_error=validation_error`,
    );
  });
});
