import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as adminUsageRoute from '../../src/app/api/studio/admin/organisations/[id]/usage/route';
import * as adminSubsRoute from '../../src/app/api/studio/admin/billing/subscriptions/route';
import * as entitlementsRoute from '../../src/app/api/studio/admin/organisations/[id]/entitlements/route';
import * as webhookRoute from '../../src/app/api/billing/stripe/webhook/route';
import * as billingRoute from '../../src/app/api/studio/billing/route';
import * as checkoutRoute from '../../src/app/api/studio/billing/checkout/route';
import * as invoicesRoute from '../../src/app/api/studio/billing/invoices/route';
import * as plansRoute from '../../src/app/api/studio/billing/plans/route';
import * as portalRoute from '../../src/app/api/studio/billing/portal/route';
import * as generateRoute from '../../src/app/api/studio/projects/[id]/generate/route';
import * as projectsRoute from '../../src/app/api/studio/projects/route';
import { setApiDeps } from '../../src/lib/studio/api/context';
import { capAdjustmentFor } from '../../src/lib/studio/billing/cost-adjustments';
import { trialStateFor } from '../../src/lib/studio/billing/entitlements';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { createPricingSource } from '../../src/lib/studio/billing/pricing';
import { createBillingService } from '../../src/lib/studio/billing/service';
import { setPricingSource } from '../../src/lib/studio/billing/wiring';
import { setWebhookDepsForTest } from '../../src/lib/studio/billing/webhook-route';
import { StudioCapability } from '../../src/lib/rbac';
import { ALL_CAPABILITIES, call, installApi, tenant } from '../helpers/api-harness';
import { createFakeStripe, webhookDepsFor, type FakeStripe } from '../helpers/fake-stripe';

// Phase 18 Track C routes on real Postgres with a scripted Stripe: the billing overview, plans,
// invoices, checkout and portal (capabilities, 501 when billing is off, org scoping), the 402
// access gate through withStudioRoute, staff entitlement overrides (minimum ENTERPRISE price,
// audit, cross-org), the subscriptions / MRR list, and the public webhook route.

const hasDb = Boolean(process.env.DATABASE_URL);
const BILLING_CAPS = [
  ...ALL_CAPABILITIES,
  StudioCapability.BillingRead,
  StudioCapability.BillingManage,
];

describe.skipIf(!hasDb)('billing API', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let org: string;
  let other: string;
  let fake: FakeStripe;
  let api: ReturnType<typeof installApi>;

  function install(withBilling = true) {
    const tokens = {
      owner: tenant(org, BILLING_CAPS),
      member: tenant(org, [...ALL_CAPABILITIES, StudioCapability.BillingRead], 'member-1'),
      creator: tenant(org, ALL_CAPABILITIES, 'creator-1'),
      staff: tenant(
        'platform-staff',
        [StudioCapability.AdminBilling, StudioCapability.AdminProviders],
        'staff-1',
      ),
      stranger: tenant(other, BILLING_CAPS, 'stranger-1'),
    };
    api = installApi(db, tokens);
    const entitlements = createEntitlementsReader({ db, ttlMs: 0 });
    const billing = createBillingService({
      db,
      gateway: fake,
      logger: pino({ level: 'silent' }),
      audit: api.deps.audit,
      now: Date.now,
      appUrl: 'http://studio.test',
      env: {},
    });
    setApiDeps({
      ...api.deps,
      entitlements,
      ...(withBilling && { billing }),
    });
    setPricingSource(
      createPricingSource({ gateway: fake, logger: pino({ level: 'silent' }), env: {} }),
    );
  }

  async function entitle(organisationId: string, tier: string, access: string, status = 'active') {
    await db.orgEntitlement.upsert({
      where: { organisationId },
      create: {
        organisationId,
        tier,
        access,
        source: 'stripe',
        overrides: { derived: { tier, access, source: 'stripe', status } },
      },
      update: { tier, access, overrides: { derived: { tier, access, source: 'stripe', status } } },
    });
  }

  beforeEach(() => {
    org = `api-bill-${randomUUID()}`;
    other = `api-bill-other-${randomUUID()}`;
    fake = createFakeStripe();
    install();
  });

  afterEach(() => {
    setPricingSource(undefined);
    setWebhookDepsForTest(undefined);
  });

  afterAll(async () => {
    setApiDeps(undefined);
    await db.$disconnect();
  });

  it('GET /billing: an org without a plan sees access none, usage and trial eligibility', async () => {
    const res = await call(billingRoute.GET, { token: 'owner', path: '/api/studio/billing' });
    expect(res.status).toBe(200);
    const billing = res.json.billing as Record<string, unknown>;
    expect(billing).toMatchObject({
      entitlements: { tier: 'BASIC', access: 'none', source: 'none' },
      subscription: null,
      hasBillingAccount: false,
      trialEligible: true,
      credits: { short: 0, long: 0 },
      canManage: true,
      checkoutEnabled: true,
    });
    const member = await call(billingRoute.GET, { token: 'member', path: '/api/studio/billing' });
    expect((member.json.billing as { canManage: boolean }).canManage).toBe(false);
    expect(
      (await call(billingRoute.GET, { token: 'creator', path: '/api/studio/billing' })).status,
    ).toBe(403);
  });

  it('GET /billing/plans: the three plans, amounts from Stripe by lookup key (26.1)', async () => {
    const res = await call(plansRoute.GET, { token: 'member', path: '/api/studio/billing/plans' });
    expect(res.status).toBe(200);
    const pricing = res.json.pricing as {
      plans: Array<{
        plan: string;
        mostPopular: boolean;
        prices: Record<string, { unitAmountPence: number }>;
      }>;
      topUps: Array<{ lookupKey: string; unitAmountPence: number }>;
      trial: { days: number; videos: number };
    };
    expect(
      pricing.plans.map((p) => [
        p.plan,
        p.mostPopular,
        p.prices.week?.unitAmountPence,
        p.prices.month?.unitAmountPence,
        p.prices.year?.unitAmountPence,
      ]),
    ).toEqual([
      ['starter', false, 950, 2_900, 29_000],
      ['growth', true, 2_250, 6_900, 69_000],
      ['pro', false, 4_850, 14_900, 149_000],
    ]);
    expect(pricing.topUps.map((p) => [p.lookupKey, p.unitAmountPence])).toEqual([
      ['studio_pack_hd5', 1_700],
      ['studio_pack_hd15', 4_500],
    ]);
    expect(pricing.trial).toEqual({ days: 7, videos: 2 });
    expect(JSON.stringify(pricing)).not.toMatch(/capHeadroom|costPence/);
  });

  it('checkout: owner only, validated, returns the Stripe URL; the trial is offered once', async () => {
    const body = { kind: 'plan', plan: 'growth', interval: 'month' };
    expect(
      (
        await call(checkoutRoute.POST, {
          token: 'member',
          method: 'POST',
          path: '/api/studio/billing/checkout',
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(checkoutRoute.POST, {
          token: 'owner',
          method: 'POST',
          path: '/api/studio/billing/checkout',
          body: { ...body, plan: 'enterprise' },
        })
      ).status,
    ).toBe(400);
    // The 21.5 per-channel body is no longer accepted.
    expect(
      (
        await call(checkoutRoute.POST, {
          token: 'owner',
          method: 'POST',
          path: '/api/studio/billing/checkout',
          body: { kind: 'channels', channels: 3, interval: 'month' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(checkoutRoute.POST, {
          token: 'owner',
          method: 'POST',
          path: '/api/studio/billing/checkout',
          body: { ...body, interval: 'quarter' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(checkoutRoute.POST, {
          token: 'owner',
          method: 'POST',
          path: '/api/studio/billing/checkout',
          body: { kind: 'topup', lookupKey: 'https://evil' },
        })
      ).status,
    ).toBe(400);
    const res = await call(checkoutRoute.POST, {
      token: 'owner',
      method: 'POST',
      path: '/api/studio/billing/checkout',
      body,
    });
    expect(res.status).toBe(200);
    expect(res.json.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const params = fake.calls.find((c) => c.method === 'createCheckoutSession')?.args[0] as {
      client_reference_id: string;
      line_items: unknown;
    };
    expect(params.client_reference_id).toBe(org);
    expect(params.line_items).toEqual([{ price: 'price_studio_growth_monthly', quantity: 1 }]);
  });

  it('portal and invoices are scoped to the caller’s own organisation', async () => {
    await call(checkoutRoute.POST, {
      token: 'owner',
      method: 'POST',
      path: '/api/studio/billing/checkout',
      body: { kind: 'plan', plan: 'starter', interval: 'year' },
    });
    const portal = await call(portalRoute.POST, {
      token: 'owner',
      method: 'POST',
      path: '/api/studio/billing/portal',
      body: {},
    });
    expect(portal.status).toBe(200);
    expect(portal.json.url).toContain(`cus_${org}`);
    // Another organisation has no billing account: it never reaches ours.
    expect(
      (
        await call(portalRoute.POST, {
          token: 'stranger',
          method: 'POST',
          path: '/api/studio/billing/portal',
          body: {},
        })
      ).status,
    ).toBe(404);
    const invoices = await call(invoicesRoute.GET, {
      token: 'member',
      path: '/api/studio/billing/invoices?limit=5',
    });
    expect((invoices.json.invoices as unknown[]).length).toBe(1);
    const strangerInvoices = await call(invoicesRoute.GET, {
      token: 'stranger',
      path: '/api/studio/billing/invoices',
    });
    expect(strangerInvoices.json.invoices).toEqual([]);
  });

  it('without Stripe configured billing writes answer 501', async () => {
    install(false);
    const res = await call(checkoutRoute.POST, {
      token: 'owner',
      method: 'POST',
      path: '/api/studio/billing/checkout',
      body: { kind: 'plan', plan: 'starter', interval: 'month' },
    });
    expect(res.status).toBe(501);
  });

  describe('access gate through withStudioRoute', () => {
    it('no plan: drafting is allowed, generate is 402 plan_required', async () => {
      // A POST that does not spend (not on the spend list) passes the gate: the validation error
      // proves the request reached the handler.
      const draft = await call(projectsRoute.POST, {
        token: 'owner',
        method: 'POST',
        path: '/api/studio/projects',
        body: {},
      });
      expect(draft.status).toBe(400);
      const project = await db.videoProject.create({
        data: {
          organisationId: org,
          businessId: 'biz',
          createdByUserId: 'user-1',
          name: 'Draft',
          state: 'DRAFT',
          sourceType: 'BRIEF',
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        },
      });
      const id = project.id;
      const res = await call(generateRoute.POST, {
        token: 'owner',
        method: 'POST',
        path: `/api/studio/projects/${id}/generate`,
        params: { id },
        body: {},
      });
      expect(res.status).toBe(402);
      expect(res.json.error).toBe('plan_required');
    });

    it('read_only: mutations are 402 billing_required, billing and reads stay open', async () => {
      await entitle(org, 'PLUS', 'read_only', 'unpaid');
      const res = await call(projectsRoute.POST, {
        token: 'owner',
        method: 'POST',
        path: '/api/studio/projects',
        body: {
          name: 'x',
          businessId: 'biz',
          sourceType: 'BRIEF',
          rawInput: 'x',
          targetFormats: [],
        },
      });
      expect(res.status).toBe(402);
      expect(res.json.error).toBe('billing_required');
      expect(
        (await call(projectsRoute.GET, { token: 'owner', path: '/api/studio/projects' })).status,
      ).toBe(200);
      const checkout = await call(checkoutRoute.POST, {
        token: 'owner',
        method: 'POST',
        path: '/api/studio/billing/checkout',
        body: { kind: 'topup', lookupKey: 'studio_pack_hd5' },
      });
      expect(checkout.status).toBe(200);
    });
  });

  describe('staff entitlement overrides', () => {
    const path = () => `/api/studio/admin/organisations/${org}/entitlements`;

    it('needs studio:admin:billing', async () => {
      expect(
        (await call(entitlementsRoute.GET, { token: 'owner', path: path(), params: { id: org } }))
          .status,
      ).toBe(403);
      const res = await call(entitlementsRoute.GET, {
        token: 'staff',
        path: path(),
        params: { id: org },
      });
      expect(res.status).toBe(200);
      expect(res.json.entitlements).toMatchObject({
        organisationId: org,
        effective: { access: 'none' },
        enterprise: { monthlyCapPence: 110_000, minimumMonthlyPricePence: 141_600 },
      });
    });

    it('ENTERPRISE below the minimum price is refused (422); at the minimum it applies and is audited', async () => {
      const body = {
        tier: 'ENTERPRISE',
        access: 'full',
        reason: 'Signed contract',
        limits: { seats: 40, shortVideos: 600 },
      };
      expect(
        (
          await call(entitlementsRoute.PUT, {
            token: 'staff',
            method: 'PUT',
            path: path(),
            params: { id: org },
            body,
          })
        ).status,
      ).toBe(400);
      const low = await call(entitlementsRoute.PUT, {
        token: 'staff',
        method: 'PUT',
        path: path(),
        params: { id: org },
        body: { ...body, monthlyPricePence: 140_000 },
      });
      expect(low.status).toBe(422);
      expect(low.json.details).toMatchObject({
        reason: 'below_minimum_price',
        minimumMonthlyPricePence: 141_600,
      });
      const ok = await call(entitlementsRoute.PUT, {
        token: 'staff',
        method: 'PUT',
        path: path(),
        params: { id: org },
        body: { ...body, monthlyPricePence: 150_000 },
      });
      expect(ok.status).toBe(200);
      expect(ok.json.entitlements).toMatchObject({
        effective: { tier: 'ENTERPRISE', access: 'full', source: 'admin', limits: { seats: 40 } },
      });
      expect(api.audits).toContainEqual(
        expect.objectContaining({
          action: 'entitlement.override_set',
          resource: { type: 'organisation', id: org },
        }),
      );
      // The org now sees ENTERPRISE with full access (no cache in this test's reader).
      const own = await call(billingRoute.GET, { token: 'owner', path: '/api/studio/billing' });
      expect((own.json.billing as { entitlements: { tier: string } }).entitlements.tier).toBe(
        'ENTERPRISE',
      );
      // The other organisation is untouched.
      expect(await db.orgEntitlement.findUnique({ where: { organisationId: other } })).toBeNull();

      const cleared = await call(entitlementsRoute.DELETE, {
        token: 'staff',
        method: 'DELETE',
        path: path(),
        params: { id: org },
        body: { reason: 'Contract ended' },
      });
      expect(cleared.status).toBe(200);
      expect(
        (cleared.json.entitlements as { effective: { source: string } }).effective.source,
      ).not.toBe('admin');
    });

    describe('20.27 trials', () => {
      const started = new Date();
      async function trialing() {
        const trial = trialStateFor(started, new Date(started.getTime() + 14 * 86_400_000));
        await db.orgEntitlement.create({
          data: {
            organisationId: org,
            tier: 'STANDARD',
            access: 'full',
            source: 'trial',
            trialStartedAt: started,
            overrides: {
              derived: { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' },
              trial,
            },
          },
        });
        await db.providerUsage.create({
          data: { organisationId: org, provider: 'seedance', day: started, costPence: 1_420 },
        });
      }
      const put = (body: Record<string, unknown>) =>
        call(entitlementsRoute.PUT, {
          token: 'staff',
          method: 'PUT',
          path: path(),
          params: { id: org },
          body,
        });
      const caps = () =>
        capAdjustmentFor(db, createEntitlementsReader({ db, ttlMs: 0 }), org, new Date());

      it('GET shows the running trial and its AI cost so far; the cost guard applies its caps', async () => {
        await trialing();
        const res = await call(entitlementsRoute.GET, {
          token: 'staff',
          path: path(),
          params: { id: org },
        });
        expect(res.json.entitlements).toMatchObject({
          effective: { tier: 'STANDARD', source: 'trial' },
          trial: {
            state: 'running',
            spentPence: 1_420,
            dailyCostCapPence: 1_000,
            totalCostCapPence: 1_500,
            endedAt: null,
          },
        });
        expect((await caps())?.trial).toEqual({ dailyPence: 1_000, monthlyPence: 1_500 });
      });

      it('an override pauses the trial; removing it brings the trial caps back', async () => {
        await trialing();
        const res = await put({ tier: 'PLUS', reason: 'Operator account' });
        expect(res.json.entitlements).toMatchObject({
          effective: { tier: 'PLUS', source: 'admin' },
          trial: { state: 'overridden' },
        });
        expect((await caps())?.trial).toBeUndefined();
        await call(entitlementsRoute.DELETE, {
          token: 'staff',
          method: 'DELETE',
          path: path(),
          params: { id: org },
          body: { reason: 'Back to the trial' },
        });
        expect((await caps())?.trial).toEqual({ dailyPence: 1_000, monthlyPence: 1_500 });
      });

      it('End trial now: audited, no trial caps from then on, even after the override is removed', async () => {
        await trialing();
        const res = await put({ tier: 'PLUS', endTrial: true, reason: 'Operator account' });
        expect(res.status).toBe(200);
        expect(res.json.entitlements).toMatchObject({
          effective: { tier: 'PLUS', source: 'admin' },
          trial: { state: 'ended', endedByUserId: 'staff-1' },
        });
        expect(api.audits).toContainEqual(
          expect.objectContaining({
            action: 'entitlement.override_set',
            metadata: expect.objectContaining({
              trialEnded: { endedAt: expect.any(String) },
              after: { tier: 'PLUS', access: 'full' },
            }),
          }),
        );
        expect((await caps())?.trial).toBeUndefined();
        // Ending it twice is refused.
        expect((await put({ endTrial: true, reason: 'Again' })).status).toBe(400);

        await call(entitlementsRoute.DELETE, {
          token: 'staff',
          method: 'DELETE',
          path: path(),
          params: { id: org },
          body: { reason: 'Plan set in Stripe' },
        });
        const after = await call(entitlementsRoute.GET, {
          token: 'staff',
          path: path(),
          params: { id: org },
        });
        expect(after.json.entitlements).toMatchObject({
          effective: { tier: 'STANDARD', source: 'trial' },
          trial: { state: 'ended' },
        });
        expect(
          (after.json.entitlements as { effective: { trial?: unknown } }).effective.trial,
        ).toBe(undefined);
        expect((await caps())?.trial).toBeUndefined();
      });

      it('End trial now on its own ends the trial without creating an override', async () => {
        await trialing();
        const res = await put({ endTrial: true, reason: 'Trial over early' });
        expect(res.status).toBe(200);
        expect(res.json.entitlements).toMatchObject({
          effective: { tier: 'STANDARD', source: 'trial' },
          admin: null,
          trial: { state: 'ended' },
        });
        expect((await caps())?.trial).toBeUndefined();
      });

      it('End trial now is refused when there is no trial', async () => {
        await entitle(org, 'PLUS', 'full');
        expect((await put({ endTrial: true, reason: 'No trial here' })).status).toBe(400);
      });
    });

    it('validates reason and expiry', async () => {
      const bad = await call(entitlementsRoute.PUT, {
        token: 'staff',
        method: 'PUT',
        path: path(),
        params: { id: org },
        body: { tier: 'PLUS', reason: 'x' },
      });
      expect(bad.status).toBe(400);
      const past = await call(entitlementsRoute.PUT, {
        token: 'staff',
        method: 'PUT',
        path: path(),
        params: { id: org },
        body: { tier: 'PLUS', reason: 'Goodwill', expiresAt: '2020-01-01T00:00:00Z' },
      });
      expect(past.status).toBe(400);
    });
  });

  it('admin usage reads the stored tier (org_entitlements) before the last generation', async () => {
    await entitle(org, 'PLUS', 'full');
    const res = await call(adminUsageRoute.GET, {
      token: 'staff',
      path: `/api/studio/admin/organisations/${org}/usage`,
      params: { id: org },
    });
    expect(res.status).toBe(200);
    expect((res.json.usage as { tier: unknown }).tier).toEqual({
      value: 'PLUS',
      source: 'entitlements',
    });
  });

  it('subscriptions list: MRR counts active and past_due, annual ÷ 12', async () => {
    await db.subscription.createMany({
      data: [
        {
          id: `sub_a_${org}`,
          organisationId: org,
          stripeCustomerId: 'c',
          status: 'active',
          lookupKey: 'studio_plus_monthly',
          interval: 'month',
          unitAmountPence: 34_900,
        },
        {
          id: `sub_b_${org}`,
          organisationId: other,
          stripeCustomerId: 'd',
          status: 'past_due',
          lookupKey: 'studio_basic_yearly',
          interval: 'year',
          unitAmountPence: 29_000,
        },
        {
          id: `sub_c_${org}`,
          organisationId: other,
          stripeCustomerId: 'd',
          status: 'canceled',
          lookupKey: 'studio_basic_monthly',
          interval: 'month',
          unitAmountPence: 2_900,
        },
      ],
    });
    expect(
      (
        await call(adminSubsRoute.GET, {
          token: 'owner',
          path: '/api/studio/admin/billing/subscriptions',
        })
      ).status,
    ).toBe(403);
    const res = await call(adminSubsRoute.GET, {
      token: 'staff',
      path: '/api/studio/admin/billing/subscriptions?limit=200',
    });
    expect(res.status).toBe(200);
    const subs = res.json.subscriptions as Array<{ id: string; mrrPence: number }>;
    expect(subs.find((s) => s.id === `sub_a_${org}`)?.mrrPence).toBe(34_900);
    expect(subs.find((s) => s.id === `sub_b_${org}`)?.mrrPence).toBe(2_417);
    expect(subs.find((s) => s.id === `sub_c_${org}`)?.mrrPence).toBe(0);
    const filtered = await call(adminSubsRoute.GET, {
      token: 'staff',
      path: '/api/studio/admin/billing/subscriptions?status=past_due',
    });
    expect(
      (filtered.json.subscriptions as Array<{ status: string }>).every(
        (s) => s.status === 'past_due',
      ),
    ).toBe(true);
    await db.subscription.deleteMany({
      where: { id: { in: [`sub_a_${org}`, `sub_b_${org}`, `sub_c_${org}`] } },
    });
  });

  describe('POST /api/billing/stripe/webhook', () => {
    const post = (body: string, signature?: string) =>
      webhookRoute.POST(
        new Request('http://studio.test/api/billing/stripe/webhook', {
          method: 'POST',
          body,
          headers: signature ? { 'stripe-signature': signature } : {},
        }),
      );

    it('answers 503 until Stripe is configured', async () => {
      const res = await post('{}', 'sig');
      expect(res.status).toBe(503);
    });

    it('400 for a missing or bad signature; 200 once recorded', async () => {
      setWebhookDepsForTest(webhookDepsFor(db, fake));
      expect((await post('{}')).status).toBe(400);
      expect((await post('{}', 't=1,v1=deadbeef')).status).toBe(400);
      const delivery = fake.deliver('product.created', { id: 'prod_1' });
      const res = await post(delivery.raw, delivery.signature);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, outcome: 'ignored' });
      const again = await post(delivery.raw, delivery.signature);
      expect(await again.json()).toMatchObject({ outcome: 'duplicate' });
    });
  });
});
