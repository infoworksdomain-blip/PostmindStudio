import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as callbackRoute from '../../src/app/api/studio/platform-connections/oauth-callback/route';
import * as initRoute from '../../src/app/api/studio/platform-connections/oauth-init/route';
import * as refreshRoute from '../../src/app/api/studio/image-library/refresh/route';
import { ConfigurationError } from '../../src/lib/errors';
import { setApiDeps } from '../../src/lib/studio/api/context';
import type { OAuthClient, OAuthPlatform } from '../../src/lib/studio/platforms/oauth';
import { APP_URL, call, installApi, rawCall, tenant } from '../helpers/api-harness';
import { createHarness } from '../helpers/pipeline-harness';

// QA 6 (Business & Images, Connections): bugs found through the UI, pinned at the API.
//  - the OAuth callback must never leave a person on a raw JSON page;
//  - "Refresh stock" must say so when no stock photo provider is set up, not claim it started.

const hasDb = Boolean(process.env.DATABASE_URL);

const client = (platform: OAuthPlatform): OAuthClient => ({
  platform,
  usesPkce: false,
  authorizeUrl: ({ state }) => `https://auth.invalid/${platform}?state=${state}`,
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  fetchAccount: vi.fn(),
});

describe.skipIf(!hasDb)('QA 6: connections callback and stock refresh', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `qa6-${randomUUID()}`;
  const tokens = { owner: tenant(org) };

  afterAll(async () => {
    setApiDeps(undefined);
    await db.businessProfile.deleteMany({ where: { organisationId: org } });
    await db.$disconnect();
  });

  describe('oauth-callback', () => {
    let api: ReturnType<typeof installApi>;
    beforeEach(() => {
      api = installApi(db, tokens);
      api.oauthClients.set('tiktok', client('tiktok'));
    });

    const html = { accept: 'text/html,application/xhtml+xml' };
    const callback = (query: string, headers: Record<string, string> = {}) =>
      rawCall(callbackRoute.GET as never, {
        path: `/api/studio/platform-connections/oauth-callback?${query}`,
        headers,
      });

    it('sends a browser with an unknown or used state back to Connections, with a reason', async () => {
      const res = await callback('code=abc&state=nope', html);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe(`${APP_URL}/connections`);
      expect(location.searchParams.get('connection_error')).toBe('state_expired');
    });

    it('does the same when the state is missing', async () => {
      const res = await callback('code=abc', html);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location') ?? '').searchParams.get('connection_error')).toBe(
        'state_expired',
      );
    });

    it('still answers scripts (no HTML accepted) with the JSON error', async () => {
      const res = await callback('code=abc&state=nope');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('validation_error');
    });

    it('returns a browser to the page that started the flow when the platform sends no code', async () => {
      const started = await call(initRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { platform: 'tiktok', businessId: 'biz-1', returnTo: `${APP_URL}/connections` },
      });
      const state = new URL(started.json.authorizeUrl as string).searchParams.get('state') ?? '';
      const res = await callback(`state=${state}`, html);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.pathname).toBe('/connections');
      expect(location.searchParams.get('connection_error')).toBe('validation_error');
    });
  });

  describe('refresh stock', () => {
    it('says no stock provider is set up instead of queueing a job that cannot run', async () => {
      const h = createHarness(db);
      h.deps.scan.stock = () => {
        throw new ConfigurationError('No stock image provider configured (PEXELS_API_KEY)');
      };
      installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
      const biz = `biz-${randomUUID()}`;
      await db.businessProfile.create({
        data: {
          organisationId: org,
          businessId: biz,
          industry: 'Food',
          subNiche: 'bakery',
          imageSearchQueries: ['sourdough'],
          classifierModel: 'test',
        },
      });
      const res = await call(refreshRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { businessId: biz },
      });
      expect(res.status).toBe(501);
      expect(res.json).toMatchObject({
        error: 'not_implemented',
        details: { reason: 'stock_not_configured' },
      });
      // Customers never read setting names.
      expect(JSON.stringify(res.json)).not.toMatch(/PEXELS|API_KEY/);
    });

    it('queues the refresh when a stock provider is set up', async () => {
      const h = createHarness(db, {
        stockSources: [
          { provider: 'pexels', search: async () => [], downloadUrl: async () => 'https://x' },
        ],
      });
      installApi(db, tokens, { queue: h.queue, publishing: h.deps.publishing, pipeline: h.deps });
      const res = await call(refreshRoute.POST, {
        method: 'POST',
        token: 'owner',
        body: { businessId: 'biz-q', queries: ['sourdough'] },
      });
      expect(res.status).toBe(202);
    });
  });
});
