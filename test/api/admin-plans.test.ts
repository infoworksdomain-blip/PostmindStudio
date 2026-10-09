import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as entitlementsRoute from '../../src/app/api/studio/admin/organisations/[id]/entitlements/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { StudioCapability } from '../../src/lib/rbac';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';

// 26.1 (operator 2026-10-09): staff give an organisation a plan (Starter / Growth / Pro, weekly /
// monthly / yearly) with the entitlement override; it is stored on the override and the effective
// plan reports it as set by staff, with that plan's seats and businesses. A 21.5 row that stored
// a channel count reads as the mapped plan. Real Postgres (same setup as test/api/billing.test.ts).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin plan override API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let org: string;
  const path = () => `/api/studio/admin/organisations/${org}/entitlements`;

  async function seed(derived: Prisma.InputJsonObject) {
    await db.orgEntitlement.create({
      data: {
        organisationId: org,
        tier: 'STANDARD',
        access: 'full',
        source: 'stripe',
        overrides: { derived },
      },
    });
  }
  const base = { tier: 'STANDARD', access: 'full', source: 'stripe', status: 'active' };

  beforeEach(async () => {
    org = `api-plan-admin-${randomUUID()}`;
    const api = installApi(db, {
      owner: tenant(org, ALL_CAPABILITIES),
      staff: tenant('platform-staff', [StudioCapability.AdminBilling], 'staff-1'),
    });
    setApiDeps({ ...api.deps, entitlements: createEntitlementsReader({ db, ttlMs: 0 }) });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  const get = () =>
    call(entitlementsRoute.GET, { token: 'staff', path: path(), params: { id: org } });
  const put = (body: Record<string, unknown>) =>
    call(entitlementsRoute.PUT, {
      token: 'staff',
      method: 'PUT',
      path: path(),
      params: { id: org },
      body,
    });

  it('reports the Stripe plan before any override', async () => {
    await seed({ ...base, plan: 'growth', interval: 'month' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.json.entitlements).toMatchObject({
      effective: {
        tier: 'STANDARD',
        plan: { id: 'growth', interval: 'month', source: 'stripe' },
        limits: { seats: 3, businesses: 1 },
      },
    });
  });

  it('a 21.5 row that stored 2 channels reads as Growth', async () => {
    await seed({ ...base, channels: 2, interval: 'year' });
    expect((await get()).json.entitlements).toMatchObject({
      effective: { plan: { id: 'growth', interval: 'year', source: 'stripe' } },
    });
  });

  it('PUT {plan: pro, interval: week} stores the override; GET returns it as set by staff', async () => {
    await seed({ ...base, plan: 'growth', interval: 'month' });
    const res = await put({ plan: 'pro', interval: 'week', reason: 'Agency pilot' });
    expect(res.status).toBe(200);
    expect(res.json.entitlements).toMatchObject({
      effective: {
        plan: { id: 'pro', interval: 'week', source: 'admin' },
        limits: { seats: 10, businesses: 3 },
      },
      admin: { plan: 'pro', interval: 'week', reason: 'Agency pilot' },
    });

    const row = await db.orgEntitlement.findUnique({ where: { organisationId: org } });
    expect(row?.overrides).toMatchObject({ admin: { plan: 'pro', interval: 'week' } });
    expect((row?.overrides as { admin: Record<string, unknown> }).admin).not.toHaveProperty(
      'channels',
    );

    expect((await get()).json.entitlements).toMatchObject({
      effective: { plan: { id: 'pro', interval: 'week', source: 'admin' } },
    });
  });

  it('refuses an unknown plan, a channel count and an unknown interval (400)', async () => {
    await seed({ ...base, plan: 'growth', interval: 'month' });
    expect((await put({ plan: 'enterprise', reason: 'Unknown plan' })).status).toBe(400);
    expect((await put({ channels: 4, reason: 'Old field' })).status).toBe(400);
    expect((await put({ interval: 'day', reason: 'Daily' })).status).toBe(400);
  });
});
