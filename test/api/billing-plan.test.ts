import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as billingRoute from '../../src/app/api/studio/billing/route';
import * as cancelRoute from '../../src/app/api/studio/billing/plan/cancel/route';
import * as previewRoute from '../../src/app/api/studio/billing/plan/preview/route';
import * as resumeRoute from '../../src/app/api/studio/billing/plan/resume/route';
import * as planRoute from '../../src/app/api/studio/billing/plan/route';
import * as scheduledRoute from '../../src/app/api/studio/billing/plan/scheduled/route';
import * as publicationsRoute from '../../src/app/api/studio/publications/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { createPricingSource } from '../../src/lib/studio/billing/pricing';
import { createBillingService } from '../../src/lib/studio/billing/service';
import { syncSubscription } from '../../src/lib/studio/billing/sync';
import { setPricingSource } from '../../src/lib/studio/billing/wiring';
import { StudioCapability } from '../../src/lib/rbac';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';
import { createFakeStripe, type FakeStripe } from '../helpers/fake-stripe';

// 21.5 Your plan routes on real Postgres with a scripted Stripe: preview, change (upgrade now /
// downgrade at period end), cancel, resume, keep the current plan; owner only, validated, scoped
// to the caller's organisation; the overview shows channels, never costs; and the channel limit
// on POST /publications.

const hasDb = Boolean(process.env.DATABASE_URL);
const BILLING_CAPS = [
  ...ALL_CAPABILITIES,
  StudioCapability.BillingRead,
  StudioCapability.BillingManage,
];

describe.skipIf(!hasDb)('Your plan API (21.5)', { timeout: 120_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let org: string;
  let other: string;
  let fake: FakeStripe;
  let api: ReturnType<typeof installApi>;

  function install() {
    api = installApi(db, {
      owner: tenant(org, BILLING_CAPS),
      member: tenant(org, [...ALL_CAPABILITIES, StudioCapability.BillingRead], 'member-1'),
      stranger: tenant(other, BILLING_CAPS, 'stranger-1'),
    });
    const billing = createBillingService({
      db,
      gateway: fake,
      logger: pino({ level: 'silent' }),
      audit: api.deps.audit,
      now: Date.now,
      appUrl: 'http://studio.test',
      env: {},
    });
    setApiDeps({ ...api.deps, entitlements: createEntitlementsReader({ db, ttlMs: 0 }), billing });
    setPricingSource(
      createPricingSource({ gateway: fake, logger: pino({ level: 'silent' }), env: {} }),
    );
  }

  async function subscribe(quantity: number) {
    await db.billingCustomer.create({
      data: { organisationId: org, stripeCustomerId: `cus_${org}`, idempotencyNonce: 'n' },
    });
    const state = fake.setSubscription({
      id: `sub_${org}`,
      customerId: `cus_${org}`,
      quantity,
      currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
    });
    await syncSubscription(
      {
        db,
        gateway: fake,
        logger: pino({ level: 'silent' }),
        audit: () => undefined,
        now: Date.now,
      },
      state,
      'test',
    );
  }

  const post = (
    route: { POST: typeof planRoute.POST },
    path: string,
    body: unknown,
    token = 'owner',
  ) => call(route.POST, { token, method: 'POST', path, body });

  beforeEach(() => {
    org = `api-plan-${randomUUID()}`;
    other = `api-plan-other-${randomUUID()}`;
    fake = createFakeStripe();
    install();
  });

  afterEach(() => setPricingSource(undefined));

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  it('preview: owner only, validated, shows the new price and what is due now', async () => {
    await subscribe(2);
    const path = '/api/studio/billing/plan/preview?channels=3&interval=month';
    expect((await call(previewRoute.GET, { token: 'member', path })).status).toBe(403);
    expect(
      (
        await call(previewRoute.GET, {
          token: 'owner',
          path: '/api/studio/billing/plan/preview?channels=9&interval=month',
        })
      ).status,
    ).toBe(400);
    const res = await call(previewRoute.GET, { token: 'owner', path });
    expect(res.status).toBe(200);
    expect(res.json.preview).toMatchObject({
      timing: 'now',
      nextPricePence: 8_700,
      dueNowPence: 1_234,
      current: { channels: 2, interval: 'month' },
    });
    // Another organisation has no plan: it never sees ours.
    expect((await call(previewRoute.GET, { token: 'stranger', path })).status).toBe(404);
  });

  it('change: upgrade now, downgrade at period end, keep the current plan', async () => {
    await subscribe(2);
    const up = await post(planRoute, '/api/studio/billing/plan', {
      channels: 4,
      interval: 'month',
      prorationDate: Math.floor(Date.now() / 1000),
    });
    expect(up.status).toBe(200);
    expect(up.json.outcome).toEqual({ status: 'applied', timing: 'now' });

    const down = await post(planRoute, '/api/studio/billing/plan', {
      channels: 1,
      interval: 'month',
    });
    expect(down.json.outcome).toMatchObject({ status: 'scheduled', timing: 'period_end' });
    const overview = await call(billingRoute.GET, { token: 'owner', path: '/api/studio/billing' });
    expect(overview.json.billing).toMatchObject({
      plan: { channels: 4, interval: 'month', pending: { channels: 1 } },
    });
    expect(JSON.stringify(overview.json)).not.toMatch(/spentPence|capPence|costPence/);

    const keep = await call(scheduledRoute.DELETE, {
      token: 'owner',
      method: 'DELETE',
      path: '/api/studio/billing/plan/scheduled',
    });
    expect(keep.status).toBe(200);
    const again = await call(scheduledRoute.DELETE, {
      token: 'owner',
      method: 'DELETE',
      path: '/api/studio/billing/plan/scheduled',
    });
    expect(again.status).toBe(409);
    expect(
      (await post(planRoute, '/api/studio/billing/plan', { channels: 0, interval: 'month' }))
        .status,
    ).toBe(400);
    expect(
      (await post(planRoute, '/api/studio/billing/plan', { channels: 2, interval: 'day' })).status,
    ).toBe(400);
    expect(
      (
        await post(
          planRoute,
          '/api/studio/billing/plan',
          { channels: 2, interval: 'month' },
          'member',
        )
      ).status,
    ).toBe(403);
  });

  it('cancel and resume', async () => {
    await subscribe(3);
    const cancel = await post(cancelRoute, '/api/studio/billing/plan/cancel', {});
    expect(cancel.status).toBe(200);
    expect(cancel.json.endsAt).toEqual(expect.any(String));
    const overview = await call(billingRoute.GET, { token: 'owner', path: '/api/studio/billing' });
    expect(overview.json.billing).toMatchObject({ subscription: { cancelAtPeriodEnd: true } });
    expect((await post(resumeRoute, '/api/studio/billing/plan/resume', {})).status).toBe(200);
    expect((await post(resumeRoute, '/api/studio/billing/plan/resume', {})).status).toBe(409);
    expect(
      (await post(cancelRoute, '/api/studio/billing/plan/cancel', {}, 'stranger')).status,
    ).toBe(404);
  });

  it('publishing past the paid channels answers channel_limit (an upgrade prompt)', async () => {
    await subscribe(1);
    const base = {
      organisationId: org,
      connectedByUserId: 'owner',
      encryptedAccessToken: 'x',
      scopes: [],
    };
    await db.platformConnection.create({
      data: {
        ...base,
        platform: 'tiktok',
        platformAccountId: 'tt',
        platformAccountName: 'TT',
        state: 'active',
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const yt = await db.platformConnection.create({
      data: {
        ...base,
        platform: 'youtube',
        platformAccountId: 'yt',
        platformAccountName: 'YT',
        state: 'active',
        connectedAt: new Date('2026-10-02T00:00:00Z'),
      },
    });
    const project = await db.videoProject.create({
      data: {
        organisationId: org,
        businessId: 'biz',
        createdByUserId: 'owner',
        name: 'P',
        state: 'APPROVED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'youtube_short', aspectRatio: '9:16', duration: 20 }],
      },
    });
    const render = await db.videoRender.create({
      data: {
        projectId: project.id,
        scriptId: 'script-1',
        targetPlatform: 'youtube_short',
        aspectRatio: '9:16',
        durationSec: 20,
        fps: 30,
        bitrateKbps: 4_000,
        resolution: '1080x1920',
        s3Bucket: 'b',
        s3Key: `render-${org}`,
        qualityCheckState: 'PASSED',
      },
    });
    await api.storage.put({
      bucket: 'b',
      key: `render-${org}`,
      body: new Uint8Array(1_000),
      contentType: 'video/mp4',
    });
    const res = await call(publicationsRoute.POST, {
      token: 'owner',
      method: 'POST',
      path: '/api/studio/publications',
      body: {
        renderId: render.id,
        platform: 'youtube_short',
        connectionId: yt.id,
        caption: 'Hello',
        hashtags: ['a', 'b', 'c', 'd', 'e'],
      },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('channel_limit');
    expect(res.json.details).toMatchObject({
      channels: 1,
      platform: 'youtube',
      allowedPlatforms: ['tiktok'],
    });
  });
});
