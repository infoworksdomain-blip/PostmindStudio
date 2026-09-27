import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as channelRoute from '../../src/app/api/studio/internal/channels/[id]/route';
import * as channelsRoute from '../../src/app/api/studio/internal/channels/route';
import * as refreshedRoute from '../../src/app/api/studio/internal/tokens/refreshed/route';
import * as userConnectionRoute from '../../src/app/api/studio/platform-connections/[id]/route';
import * as listRoute from '../../src/app/api/studio/platform-connections/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createMemoryRateLimitStore, createRateLimiter } from '../../src/lib/studio/api/rate-limit';
import { decryptSecret, tokenContext } from '../../src/lib/studio/crypto/envelope';
import { createStoredMetaCredentials } from '../../src/lib/studio/platforms/meta-credentials';
import { call, installApi, tenant } from '../helpers/api-harness';

// Internal service-to-service endpoints PostMind Core calls for Meta channels (Engagement
// handover 9.5 / 9.6 / 14.13): X-Service-Token auth, register / refresh / disconnect,
// encryption at rest, organisation isolation, audit, and no token in any response.

const hasDb = Boolean(process.env.DATABASE_URL);
const SERVICE_TOKEN = 's'.repeat(48);
const auth = { 'x-service-token': SERVICE_TOKEN };

describe.skipIf(!hasDb)('internal Meta channel API', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `api-internal-${randomUUID()}`;
  const otherOrg = `api-internal-other-${randomUUID()}`;
  let api: ReturnType<typeof installApi>;
  let n = 0;
  const igId = () => `1784140${Date.now() % 1_000_000}${(n += 1)}`;

  const body = (overrides: Record<string, unknown> = {}) => ({
    organisationId: org,
    platform: 'instagram',
    platformAccountId: igId(),
    platformAccountName: '@leeds.sourdough',
    accessToken: `EAAG${randomUUID().replace(/-/g, '')}`,
    tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
    ...overrides,
  });

  const refOf = (b: Record<string, unknown>) => ({
    organisationId: b.organisationId,
    platform: b.platform,
    platformAccountId: b.platformAccountId,
  });

  const register = (b: Record<string, unknown>, headers: Record<string, string> = auth) =>
    call(channelsRoute.POST, {
      method: 'POST',
      path: '/api/studio/internal/channels',
      body: b,
      headers,
    });

  beforeEach(() => {
    vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', SERVICE_TOKEN);
    api = installApi(db, { owner: tenant(org), stranger: tenant(otherOrg) });
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.platformConnection.deleteMany({ where: { organisationId: { in: [org, otherOrg] } } });
    await db.$disconnect();
  });

  describe('authentication', () => {
    it('404s every endpoint while STUDIO_INTERNAL_SERVICE_TOKEN is unset or too short', async () => {
      for (const value of ['', 'short-token']) {
        vi.stubEnv('STUDIO_INTERNAL_SERVICE_TOKEN', value);
        expect((await register(body())).status).toBe(404);
        const del = await call(channelRoute.DELETE, {
          method: 'DELETE',
          params: { id: 'x' },
          headers: auth,
        });
        expect(del.status).toBe(404);
        const refreshed = await call(refreshedRoute.POST, {
          method: 'POST',
          body: {},
          headers: auth,
        });
        expect(refreshed.status).toBe(404);
      }
    });

    it('401s a missing or wrong X-Service-Token, and a user JWT is not accepted', async () => {
      expect((await register(body(), {})).status).toBe(401);
      expect((await register(body(), { 'x-service-token': `${SERVICE_TOKEN}x` })).status).toBe(401);
      const jwt = await call(channelsRoute.POST, {
        method: 'POST',
        body: body(),
        token: 'owner',
      });
      expect(jwt.status).toBe(401);
      expect(await db.platformConnection.count({ where: { organisationId: org } })).toBe(0);
    });

    it('rate limits Core calls when a limiter is configured', async () => {
      api.deps.internalRateLimiter = createRateLimiter(createMemoryRateLimitStore(), {
        readsPerMin: 1,
        writesPerMin: 1,
        orgPerMin: 1,
      });
      expect((await register(body())).status).toBe(201);
      const limited = await register(body());
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
    });

    it('413s an oversized body and 400s an invalid one without echoing the token', async () => {
      const big = await register(body({ platformAccountName: 'x'.repeat(70_000) }));
      expect(big.status).toBe(413);
      const bad = await register(
        body({ platform: 'tiktok', accessToken: 'EAAG-SECRET-VALUE-123' }),
      );
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.json)).not.toContain('EAAG-SECRET-VALUE-123');
    });
  });

  it('registers a channel encrypted at rest, idempotently, and never returns the token', async () => {
    const b = body({ businessId: 'biz-1' });
    const created = await register(b);
    expect(created.status).toBe(201);
    const channel = created.json.channel as Record<string, unknown>;
    expect(channel).toMatchObject({
      organisationId: org,
      platform: 'instagram',
      platformAccountId: b.platformAccountId,
      businessId: 'biz-1',
      state: 'active',
    });
    expect(JSON.stringify(created.json)).not.toContain(b.accessToken as string);
    expect(JSON.stringify(created.json)).not.toContain('encrypted');

    const row = await db.platformConnection.findUniqueOrThrow({
      where: { id: channel.id as string },
    });
    expect(row.encryptedAccessToken).toMatch(/^v1\.local\./);
    expect(row.encryptedAccessToken).not.toContain(b.accessToken as string);
    expect(row.encryptedRefreshToken).toBeNull();
    expect(row.connectedByUserId).toBe('system:postmind-core');
    await expect(
      decryptSecret(
        api.publishing.keys,
        row.encryptedAccessToken,
        tokenContext({ organisationId: org, platform: 'instagram', kind: 'access' }),
      ),
    ).resolves.toBe(b.accessToken);
    // Bound to its organisation: the same ciphertext does not open under another org's context.
    await expect(
      decryptSecret(
        api.publishing.keys,
        row.encryptedAccessToken,
        tokenContext({ organisationId: otherOrg, platform: 'instagram', kind: 'access' }),
      ),
    ).rejects.toThrow();

    // Re-registration (a reconnect) updates in place: 200, same id, new token, business kept.
    const again = await register({
      ...b,
      businessId: undefined,
      accessToken: 'EAAG-new-token-0001',
    });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false });
    expect((again.json.channel as { id: string }).id).toBe(channel.id);
    const credentials = createStoredMetaCredentials({
      db,
      keys: api.publishing.keys,
      now: Date.now,
    });
    await expect(
      credentials.getCredentials({
        organisationId: org,
        platform: 'instagram',
        platformAccountId: b.platformAccountId as string,
      }),
    ).resolves.toMatchObject({ accessToken: 'EAAG-new-token-0001' });
    expect(
      (await db.platformConnection.findUniqueOrThrow({ where: { id: channel.id as string } }))
        .businessId,
    ).toBe('biz-1');

    expect(api.audits.map((a) => a.action)).toEqual([
      'studio.connection.meta_register',
      'studio.connection.meta_reregister',
    ]);
    expect(api.audits[0]).toMatchObject({
      actorUserId: 'system:postmind-core',
      organisationId: org,
      resource: { type: 'platform_connection', id: channel.id },
    });
    expect(JSON.stringify(api.audits)).not.toContain(b.accessToken as string);
  });

  it('refuses a Studio-side user disconnect of a Core-owned Meta channel (409)', async () => {
    const id = ((await register(body())).json.channel as { id: string }).id;
    const res = await call(userConnectionRoute.DELETE, {
      method: 'DELETE',
      token: 'owner',
      params: { id },
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.json)).toContain('PostMind settings');
    expect((await db.platformConnection.findUniqueOrThrow({ where: { id } })).state).toBe('active');
  });

  it('shows registered channels only to their organisation in /platform-connections', async () => {
    const mine = await register(body({ platform: 'facebook', platformAccountName: 'Bakery Page' }));
    const theirs = await register(body({ organisationId: otherOrg, platformAccountName: 'Other' }));
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const list = await call(listRoute.GET, { token: 'owner' });
    const names = (list.json.data as Array<{ platformAccountName: string }>).map(
      (c) => c.platformAccountName,
    );
    expect(names).toContain('Bakery Page');
    expect(names).not.toContain('Other');
    expect(JSON.stringify(list.json)).not.toContain('encryptedAccessToken');

    // Disconnect with the wrong organisation is a 404 and changes nothing.
    const id = (theirs.json.channel as { id: string }).id;
    const wrongOrg = await call(channelRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/internal/channels/${id}?organisationId=${org}`,
      params: { id },
      headers: auth,
    });
    expect(wrongOrg.status).toBe(404);
    expect((await db.platformConnection.findUniqueOrThrow({ where: { id } })).state).toBe('active');
  });

  it('refreshes tokens (single and batch), reactivates needs_reconnect, and keeps revoked', async () => {
    const a = body();
    const b = body({ platform: 'facebook' });
    const aId = ((await register(a)).json.channel as { id: string }).id;
    await register(b);
    await db.platformConnection.update({ where: { id: aId }, data: { state: 'needs_reconnect' } });

    const expires = new Date(Date.now() + 59 * 86_400_000).toISOString();
    const single = await call(refreshedRoute.POST, {
      method: 'POST',
      headers: auth,
      body: {
        organisationId: org,
        platform: 'instagram',
        platformAccountId: a.platformAccountId,
        accessToken: 'EAAG-refreshed-aaaa',
        tokenExpiresAt: expires,
      },
    });
    expect(single.status).toBe(200);
    expect(single.json.result).toMatchObject({ result: 'updated', id: aId });
    const refreshedRow = await db.platformConnection.findUniqueOrThrow({ where: { id: aId } });
    expect(refreshedRow.state).toBe('active');
    expect(refreshedRow.accessTokenExpiresAt?.toISOString()).toBe(expires);
    await expect(
      decryptSecret(
        api.publishing.keys,
        refreshedRow.encryptedAccessToken,
        tokenContext({ organisationId: org, platform: 'instagram', kind: 'access' }),
      ),
    ).resolves.toBe('EAAG-refreshed-aaaa');

    const unknown = await call(refreshedRoute.POST, {
      method: 'POST',
      headers: auth,
      body: { ...refOf(a), platformAccountId: '999', accessToken: 'EAAG-refreshed-zzzz' },
    });
    expect(unknown.status).toBe(404);

    // Disconnect b by account, then a batch refresh: b stays revoked, a updates, unknown reported.
    const del = await call(channelsRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/internal/channels?organisationId=${org}&platform=facebook&platformAccountId=${b.platformAccountId}`,
      headers: auth,
    });
    expect(del.status).toBe(200);
    const batch = await call(refreshedRoute.POST, {
      method: 'POST',
      headers: auth,
      body: {
        channels: [
          { ...refOf(a), accessToken: 'EAAG-refreshed-bbbb' },
          { ...refOf(b), accessToken: 'EAAG-refreshed-cccc' },
          { ...refOf(a), platformAccountId: '998', accessToken: 'EAAG-refreshed-dddd' },
        ],
      },
    });
    expect(batch.status).toBe(200);
    expect((batch.json.results as Array<{ result: string }>).map((r) => r.result)).toEqual([
      'updated',
      'revoked',
      'not_found',
    ]);
    const revoked = await call(refreshedRoute.POST, {
      method: 'POST',
      headers: auth,
      body: {
        organisationId: org,
        platform: 'facebook',
        platformAccountId: b.platformAccountId,
        accessToken: 'EAAG-refreshed-eeee',
      },
    });
    expect(revoked.status).toBe(409);
    expect(
      api.audits.filter((x) => x.action === 'studio.connection.meta_token_refreshed'),
    ).toHaveLength(2);
  });

  it('disconnects by id: tokens wiped, idempotent, Studio OAuth connections untouched', async () => {
    const b = body();
    const id = ((await register(b)).json.channel as { id: string }).id;
    const first = await call(channelRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/internal/channels/${id}`,
      params: { id },
      headers: auth,
    });
    expect(first.status).toBe(200);
    expect(first.json.channel).toMatchObject({ state: 'revoked' });
    const row = await db.platformConnection.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      state: 'revoked',
      encryptedAccessToken: '',
      accessTokenExpiresAt: null,
    });
    const second = await call(channelRoute.DELETE, {
      method: 'DELETE',
      params: { id },
      headers: auth,
    });
    expect(second.status).toBe(200);
    expect(api.audits.map((a) => a.action)).toContain('studio.connection.meta_disconnect');

    const tiktok = await db.platformConnection.create({
      data: {
        organisationId: org,
        businessId: 'biz-1',
        platform: 'tiktok',
        platformAccountId: `tt-${randomUUID()}`,
        platformAccountName: 'TikTok',
        encryptedAccessToken: 'v1.local.x.y.z.w',
        scopes: [],
        state: 'active',
        connectedByUserId: 'user-1',
      },
    });
    const refused = await call(channelRoute.DELETE, {
      method: 'DELETE',
      params: { id: tiktok.id },
      headers: auth,
    });
    expect(refused.status).toBe(404);
    expect(
      (await db.platformConnection.findUniqueOrThrow({ where: { id: tiktok.id } })).state,
    ).toBe('active');

    // Credentials for a disconnected channel are a clear needs_reconnect, never a stale token.
    const credentials = createStoredMetaCredentials({
      db,
      keys: api.publishing.keys,
      now: Date.now,
    });
    await expect(
      credentials.getCredentials({
        organisationId: org,
        platform: 'instagram',
        platformAccountId: b.platformAccountId as string,
      }),
    ).rejects.toMatchObject({ errorClass: 'needs_reconnect' });
  });

  it('400s a DELETE by account without all three keys', async () => {
    const res = await call(channelsRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/internal/channels?organisationId=${org}`,
      headers: auth,
    });
    expect(res.status).toBe(400);
  });
});
