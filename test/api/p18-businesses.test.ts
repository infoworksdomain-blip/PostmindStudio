import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as businessRoute from '../../src/app/api/studio/businesses/[id]/route';
import * as profileRoute from '../../src/app/api/studio/businesses/[id]/business-profile/route';
import * as listRoute from '../../src/app/api/studio/businesses/route';
import * as initRoute from '../../src/app/api/studio/platform-connections/oauth-init/route';
import { studioModes } from '../../src/lib/mode';
import { setApiDeps, type ApiDeps } from '../../src/lib/studio/api/context';
import {
  NO_PLAN_ENTITLEMENTS,
  type EntitlementsReader,
} from '../../src/lib/studio/billing/entitlements-reader';
import { selectBusinessGuard } from '../../src/lib/studio/core/select';
import type { OAuthClient } from '../../src/lib/studio/platforms/oauth';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';

// Phase 18 §2.11 (Track D): standalone businesses — CRUD with organisation isolation, the plan's
// business limit, and assertBusinessInOrg on every write that names a businessId.

const hasDb = Boolean(process.env.DATABASE_URL);
const MANAGE = [...ALL_CAPABILITIES, 'studio:business:manage'];

function limitReader(businesses: number | null): EntitlementsReader {
  return {
    forOrganisation: vi.fn(async () => ({
      ...NO_PLAN_ENTITLEMENTS,
      limits: { ...NO_PLAN_ENTITLEMENTS.limits, businesses },
    })),
    invalidate: vi.fn(),
  };
}

const fakeTikTok: OAuthClient = {
  platform: 'tiktok',
  usesPkce: false,
  authorizeUrl: ({ state }) => `https://auth.invalid/tiktok?state=${state}`,
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  fetchAccount: vi.fn(),
};

describe.skipIf(!hasDb)('businesses API (standalone)', { timeout: 60_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  const org = `p18-biz-${randomUUID()}`;
  const other = `p18-biz-other-${randomUUID()}`;
  const tokens = {
    owner: tenant(org, MANAGE),
    reader: tenant(org, ['studio:project:read']),
    stranger: tenant(other, MANAGE),
  };
  let deps: ApiDeps;
  let audits: Array<{ action: string }> = [];

  const install = (extra: Partial<ApiDeps> = {}) => {
    const api = installApi(db, tokens);
    audits = api.audits;
    api.oauthClients.set('tiktok', fakeTikTok);
    deps = {
      ...api.deps,
      modes: studioModes({}),
      businessGuard: selectBusinessGuard(studioModes({}), db),
      ...extra,
    };
    setApiDeps(deps);
  };

  beforeEach(() => install());

  afterAll(async () => {
    setApiDeps(undefined);
    await db.business.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.businessPurge.deleteMany({ where: { organisationId: { in: [org, other] } } });
    await db.$disconnect();
  });

  const list = (token = 'owner') => call(listRoute.GET, { path: '/api/studio/businesses', token });
  const create = (body: unknown, token = 'owner') =>
    call(listRoute.POST, { method: 'POST', path: '/api/studio/businesses', token, body });
  const patch = (id: string, body: unknown, token = 'owner') =>
    call(businessRoute.PATCH, {
      method: 'PATCH',
      path: `/api/studio/businesses/${id}`,
      token,
      body,
      params: { id },
    });
  const remove = (id: string, token = 'owner') =>
    call(businessRoute.DELETE, {
      method: 'DELETE',
      path: `/api/studio/businesses/${id}`,
      token,
      params: { id },
    });

  it('starts empty, creates, lists, renames and deletes a business', async () => {
    expect((await list()).json).toEqual({ ok: true, data: [], local: true });

    const created = await create({
      name: '  Leeds Sourdough ',
      domain: 'https://LeedsSourdough.co.uk/',
    });
    expect(created.status).toBe(201);
    const business = created.json.business as { id: string; name: string; domain: string };
    expect(business).toMatchObject({ name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' });

    expect((await list()).json.data).toEqual([
      { id: business.id, name: 'Leeds Sourdough', domain: 'leedssourdough.co.uk' },
    ]);

    const renamed = await patch(business.id, { name: 'Leeds Sourdough Ltd', domain: null });
    expect(renamed.status).toBe(200);
    expect(renamed.json.business).toMatchObject({ name: 'Leeds Sourdough Ltd', domain: null });

    const deleted = await remove(business.id);
    expect(deleted.status).toBe(202);
    expect(deleted.json.purge).toMatchObject({ organisationId: org, businessId: business.id });
    expect((await list()).json.data).toEqual([]);
    const row = await db.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(row.deletedAt).not.toBeNull();

    // A deleted business frees its name (the unique index covers live rows only).
    expect((await create({ name: 'Leeds Sourdough Ltd' })).status).toBe(201);
  });

  it('refuses a duplicate name (case-insensitive) and bad input', async () => {
    expect((await create({ name: 'Market Stall' })).status).toBe(201);
    const dup = await create({ name: 'market stall' });
    expect(dup.status).toBe(409);
    expect((await create({ name: '' })).status).toBe(400);
    expect((await create({ name: 'X', domain: 'not a host' })).status).toBe(400);
    expect((await create({ name: 'X', extra: 1 })).status).toBe(400);
    expect((await patch('whatever', {})).status).toBe(404);
  });

  it('isolates organisations: another organisation neither sees nor changes a business', async () => {
    const mine = (await create({ name: `Isolated ${randomUUID()}` })).json.business as {
      id: string;
    };
    const theirs = (await list('stranger')).json.data as Array<{ id: string }>;
    expect(theirs.some((b) => b.id === mine.id)).toBe(false);
    expect((await patch(mine.id, { name: 'Taken over' }, 'stranger')).status).toBe(404);
    expect((await remove(mine.id, 'stranger')).status).toBe(404);
    const row = await db.business.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.deletedAt).toBeNull();
  });

  it('needs studio:business:manage to write and studio:project:read to list', async () => {
    expect((await create({ name: 'Nope' }, 'reader')).status).toBe(403);
    expect((await list('reader')).status).toBe(200);
    expect((await list('nobody')).status).toBe(401);
  });

  it('enforces the plan’s business limit on create', async () => {
    const reader = limitReader(0);
    install({ entitlements: reader });
    const res = await create({ name: 'Over the limit' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('quota_exceeded');
    expect(res.json.details).toMatchObject({ resource: 'businesses', limit: 0 });
    expect(reader.forOrganisation).toHaveBeenCalledWith(org);
    expect(audits.some((a) => a.action === 'studio.business.create_refused')).toBe(true);
    install({ entitlements: limitReader(null) });
    expect((await create({ name: `Unlimited ${randomUUID()}` })).status).toBe(201);
  });

  it('keeps existing businesses working after a downgrade below their number', async () => {
    const kept = (await create({ name: `Kept ${randomUUID()}` })).json.business as { id: string };
    install({ entitlements: limitReader(0) });
    expect((await list()).json.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: kept.id })]),
    );
    expect((await patch(kept.id, { name: `Renamed ${randomUUID()}` })).status).toBe(200);
    expect((await create({ name: 'One too many' })).status).toBe(403);
  });

  it('checks businessId on writes: body and path ids of another organisation are 404', async () => {
    const mine = (await create({ name: `Guarded ${randomUUID()}` })).json.business as {
      id: string;
    };
    const foreign = (await create({ name: `Foreign ${randomUUID()}` }, 'stranger')).json
      .business as { id: string };

    const init = (businessId: string) =>
      call(initRoute.POST, {
        method: 'POST',
        path: '/api/studio/platform-connections/oauth-init',
        token: 'owner',
        body: { platform: 'tiktok', businessId },
      });
    expect((await init(mine.id)).status).toBe(200);
    expect((await init(foreign.id)).status).toBe(404);
    expect((await init('never-existed')).status).toBe(404);

    const profile = (id: string) =>
      call(profileRoute.PATCH, {
        method: 'PATCH',
        path: `/api/studio/businesses/${id}/business-profile`,
        token: 'owner',
        body: { notAField: true },
        params: { id },
      });
    expect((await profile(foreign.id)).status).toBe(404);
    // Its own business passes the guard and reaches the handler's validation.
    expect((await profile(mine.id)).status).toBe(400);
  });

  it('does not guard in core mode (Core’s ids cannot be verified) and refuses CRUD there', async () => {
    install({ modes: studioModes({ STUDIO_MODE: 'core' }), businessGuard: undefined });
    expect((await create({ name: 'Core owns these' })).status).toBe(409);
    expect((await remove('biz_1')).status).toBe(409);
    const res = await call(initRoute.POST, {
      method: 'POST',
      path: '/api/studio/platform-connections/oauth-init',
      token: 'owner',
      body: { platform: 'tiktok', businessId: 'core-biz-unverifiable' },
    });
    expect(res.status).toBe(200);
  });
});
