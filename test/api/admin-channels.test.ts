import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as entitlementsRoute from '../../src/app/api/studio/admin/organisations/[id]/entitlements/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { StudioCapability } from '../../src/lib/rbac';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';

// 21.5 (operator 2026-10-04): staff give an organisation a channel plan (1–6 channels, weekly /
// monthly / yearly) with the entitlement override; it is stored on the override and the effective
// plan reports it as set by staff. Real Postgres (same setup as test/api/billing.test.ts).

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('admin channel plan override API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let org: string;
  const path = () => `/api/studio/admin/organisations/${org}/entitlements`;

  beforeEach(async () => {
    org = `api-chan-${randomUUID()}`;
    const api = installApi(db, {
      owner: tenant(org, ALL_CAPABILITIES),
      staff: tenant('platform-staff', [StudioCapability.AdminBilling], 'staff-1'),
    });
    setApiDeps({ ...api.deps, entitlements: createEntitlementsReader({ db, ttlMs: 0 }) });
    // A Stripe channel subscription: 2 channels, monthly.
    const derived = {
      tier: 'STANDARD',
      access: 'full',
      source: 'stripe',
      status: 'active',
      channels: 2,
      interval: 'month',
    };
    await db.orgEntitlement.create({
      data: {
        organisationId: org,
        tier: 'STANDARD',
        access: 'full',
        source: 'stripe',
        overrides: { derived },
      },
    });
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  const put = (body: Record<string, unknown>) =>
    call(entitlementsRoute.PUT, {
      token: 'staff',
      method: 'PUT',
      path: path(),
      params: { id: org },
      body,
    });

  it('reports the Stripe channel plan before any override', async () => {
    const res = await call(entitlementsRoute.GET, {
      token: 'staff',
      path: path(),
      params: { id: org },
    });
    expect(res.status).toBe(200);
    expect(res.json.entitlements).toMatchObject({
      effective: {
        tier: 'STANDARD',
        channelPlan: { channels: 2, interval: 'month', source: 'stripe' },
      },
    });
  });

  it('PUT {channels: 4, interval: week} stores the override; GET returns it as set by staff', async () => {
    const res = await put({ channels: 4, interval: 'week', reason: 'Agency pilot' });
    expect(res.status).toBe(200);
    expect(res.json.entitlements).toMatchObject({
      effective: { channelPlan: { channels: 4, interval: 'week', source: 'admin' } },
      admin: { channels: 4, interval: 'week', reason: 'Agency pilot' },
    });

    const row = await db.orgEntitlement.findUnique({ where: { organisationId: org } });
    expect(row?.overrides).toMatchObject({ admin: { channels: 4, interval: 'week' } });

    const get = await call(entitlementsRoute.GET, {
      token: 'staff',
      path: path(),
      params: { id: org },
    });
    expect(get.status).toBe(200);
    expect(get.json.entitlements).toMatchObject({
      effective: { channelPlan: { channels: 4, interval: 'week', source: 'admin' } },
    });
  });

  it('refuses a channel count outside 1–6 and an unknown interval (400)', async () => {
    expect((await put({ channels: 7, reason: 'Too many' })).status).toBe(400);
    expect((await put({ channels: 0, reason: 'Too few' })).status).toBe(400);
    expect((await put({ interval: 'day', reason: 'Daily' })).status).toBe(400);
  });
});
