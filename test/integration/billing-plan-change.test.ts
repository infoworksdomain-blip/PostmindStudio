import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../src/lib/audit';
import { ConflictError, NotFoundError, ValidationError } from '../../src/lib/errors';
import { createEntitlementsReader } from '../../src/lib/studio/billing/entitlements-reader';
import { billingOverview } from '../../src/lib/studio/billing/overview';
import {
  cancelPlan,
  cancelScheduledChange,
  changePlan,
  previewPlanChange,
  resumePlan,
  type PlanChangeDeps,
} from '../../src/lib/studio/billing/plan-change';
import type { PlanId, PlanInterval } from '../../src/lib/studio/billing/plans';
import { syncSubscription } from '../../src/lib/studio/billing/sync';
import { usageView } from '../../src/lib/studio/services/plan-quotas';
import { createFakeStripe, type FakeStripe } from '../helpers/fake-stripe';

// 21.5 / 26.1 Your plan (Starter / Growth / Pro) on real Postgres with a scripted Stripe: previews, upgrades now with proration
// (the previewed proration time reaches Stripe), downgrades at the end of the period (a schedule,
// stored as the pending change), one pending change at a time, trials change at once, a declined
// upgrade changes nothing, cancel / resume, and the overview the page reads.

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = Date.parse('2026-10-10T12:00:00Z');
const PERIOD_END = new Date('2026-11-01T00:00:00Z');

describe.skipIf(!hasDb)('plan changes (Stripe fake, real Postgres)', { timeout: 90_000 }, () => {
  const db = hasDb ? new PrismaClient() : (undefined as unknown as PrismaClient);
  let fake: FakeStripe;
  let audits: AuditEntry[];
  let org: string;
  let subId: string;

  const deps = (): PlanChangeDeps => ({
    db,
    gateway: fake,
    logger: pino({ level: 'silent' }),
    audit: (e) => audits.push(e),
    now: () => NOW,
    env: {},
  });
  const who = () => ({ organisationId: org, userId: 'owner-1' });
  const calls = (method: string) => fake.calls.filter((c) => c.method === method);
  const entitlements = () => createEntitlementsReader({ db, ttlMs: 0, now: () => NOW });

  async function subscribe(
    lookupKey = 'studio_growth_monthly',
    status = 'active',
    quantity = 1,
  ): Promise<void> {
    await db.billingCustomer.create({
      data: { organisationId: org, stripeCustomerId: `cus_${org}`, idempotencyNonce: 'n' },
    });
    const state = fake.setSubscription({
      id: subId,
      customerId: `cus_${org}`,
      lookupKey,
      priceId: `price_${lookupKey}`,
      interval: lookupKey.endsWith('weekly')
        ? 'week'
        : lookupKey.endsWith('yearly')
          ? 'year'
          : 'month',
      quantity,
      status,
      currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
      currentPeriodEnd: PERIOD_END,
      trialEnd: status === 'trialing' ? new Date('2026-10-15T00:00:00Z') : null,
    });
    await syncSubscription(deps(), state, 'test');
  }

  beforeEach(() => {
    fake = createFakeStripe();
    audits = [];
    org = `pc-${randomUUID()}`;
    subId = `sub_${randomUUID()}`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('upgrade to a higher plan: preview shows the prorated amount due now; the change sends that proration time', async () => {
    await subscribe('studio_starter_monthly');
    fake.previewAmountPence = 3_870;
    const preview = await previewPlanChange(deps(), org, { plan: 'growth', interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'now',
      current: { plan: 'starter', interval: 'month' },
      next: { plan: 'growth', interval: 'month' },
      nextPricePence: 6_900,
      dueNowPence: 3_870,
      prorationDate: Math.floor(NOW / 1000),
    });
    expect(calls('previewPlanChange')[0]?.args[0]).toMatchObject({
      customerId: `cus_${org}`,
      subscriptionId: subId,
      itemId: `si_${subId}`,
      priceId: 'price_studio_growth_monthly',
      quantity: 1,
    });

    const outcome = await changePlan(deps(), {
      ...who(),
      next: { plan: 'growth', interval: 'month' },
      prorationDate: preview.prorationDate,
    });
    expect(outcome).toEqual({ status: 'applied', timing: 'now' });
    expect(calls('changePlanNow')[0]?.args[0]).toMatchObject({
      priceId: 'price_studio_growth_monthly',
      quantity: 1,
      prorationDate: Math.floor(NOW / 1000),
    });
    const ent = await entitlements().forOrganisation(org);
    expect(ent.plan).toEqual({
      id: 'growth',
      interval: 'month',
      source: 'stripe',
      changedFrom: { plan: 'starter', interval: 'month', at: new Date(NOW).toISOString() },
    });
    expect(ent.limits).toMatchObject({ seats: 3, businesses: 1 });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'billing.subscription_changed',
        metadata: expect.objectContaining({
          change: 'plan',
          from: { plan: 'starter', interval: 'month' },
          to: { plan: 'growth', interval: 'month' },
          timing: 'now',
        }),
      }),
    );
  });

  it('26.3: an upgrade applied now is stored with its time and old plan; that month is blended, the next is whole', async () => {
    await subscribe('studio_starter_monthly');
    const preview = await previewPlanChange(deps(), org, { plan: 'pro', interval: 'month' });
    await changePlan(deps(), {
      ...who(),
      next: { plan: 'pro', interval: 'month' },
      prorationDate: preview.prorationDate,
    });
    const ent = await entitlements().forOrganisation(org);
    expect(ent.plan).toEqual({
      id: 'pro',
      interval: 'month',
      source: 'stripe',
      changedFrom: { plan: 'starter', interval: 'month', at: new Date(NOW).toISOString() },
    });
    // 21.5 of October's 31 days left: 8 + floor(37 × 21.5 / 31) = 33; November: Pro's 45.
    const limitOn = async (now: number) =>
      (await usageView({ db, now: () => now, env: {} }, org, 'STANDARD', undefined, ent)).videos
        .short.limit;
    expect(await limitOn(NOW)).toBe(33);
    expect(await limitOn(Date.parse('2026-11-03T00:00:00Z'))).toBe(45);
    // A webhook re-sync of the same state keeps the record.
    const state = await fake.retrieveSubscription(subId);
    if (state) await syncSubscription(deps(), state, 'webhook');
    expect((await entitlements().forOrganisation(org)).plan?.changedFrom).toBeDefined();
  });

  it('a higher plan on a shorter interval still applies now', async () => {
    await subscribe('studio_growth_yearly');
    const preview = await previewPlanChange(deps(), org, { plan: 'pro', interval: 'week' });
    expect(preview).toMatchObject({ timing: 'now', nextPricePence: 4_850 });
  });

  it('downgrade to a lower plan: applies at the end of the period (a schedule), shown as the pending change', async () => {
    await subscribe('studio_pro_monthly');
    const preview = await previewPlanChange(deps(), org, { plan: 'starter', interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'period_end',
      effectiveAt: PERIOD_END.toISOString(),
      dueNowPence: null,
      nextPricePence: 2_900,
    });
    expect(calls('previewPlanChange')).toHaveLength(0);
    const outcome = await changePlan(deps(), {
      ...who(),
      next: { plan: 'starter', interval: 'month' },
    });
    expect(outcome).toEqual({
      status: 'scheduled',
      timing: 'period_end',
      effectiveAt: PERIOD_END.toISOString(),
    });
    expect(calls('schedulePlanChange')[0]?.args[0]).toMatchObject({
      priceId: 'price_studio_starter_monthly',
      quantity: 1,
      interval: 'month',
    });
    // Still Pro until the period ends.
    expect((await entitlements().forOrganisation(org)).plan?.id).toBe('pro');
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan).toMatchObject({
      id: 'pro',
      interval: 'month',
      pricePerPeriodPence: 14_900,
      pending: { plan: 'starter', interval: 'month', effectiveAt: PERIOD_END.toISOString() },
    });

    // Keep the current plan: the schedule is released and nothing is pending.
    await cancelScheduledChange(deps(), who());
    expect(calls('releaseSchedule')).toHaveLength(1);
    const after = await billingOverview({ db, entitlements: entitlements(), now: () => NOW }, org);
    expect(after.plan?.pending).toBeNull();
    await expect(cancelScheduledChange(deps(), who())).rejects.toBeInstanceOf(ConflictError);
  });

  it('same plan: a longer period applies now, a shorter one at period end; an upgrade drops a scheduled change', async () => {
    await subscribe('studio_growth_monthly');
    const year = await previewPlanChange(deps(), org, { plan: 'growth', interval: 'year' });
    expect(year.timing).toBe('now');
    const week = await previewPlanChange(deps(), org, { plan: 'growth', interval: 'week' });
    expect(week.timing).toBe('period_end');
    await changePlan(deps(), { ...who(), next: { plan: 'growth', interval: 'week' } });
    expect(calls('schedulePlanChange')[0]?.args[0]).toMatchObject({
      interval: 'week',
      priceId: 'price_studio_growth_weekly',
      organisationId: org,
    });
    await changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'month' } });
    expect(calls('releaseSchedule')).toHaveLength(1);
    const ent = await entitlements().forOrganisation(org);
    expect(ent.plan?.id).toBe('pro');
    await expect(
      changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('a trial changes at once with no proration (nothing is charged until it ends)', async () => {
    await subscribe('studio_pro_monthly', 'trialing');
    const preview = await previewPlanChange(deps(), org, { plan: 'starter', interval: 'month' });
    expect(preview).toMatchObject({ timing: 'now', dueNowPence: 0, prorationDate: null });
    await changePlan(deps(), { ...who(), next: { plan: 'starter', interval: 'month' } });
    expect(calls('changePlanNow')[0]?.args[0]).toMatchObject({
      prorationDate: null,
      quantity: 1,
      priceId: 'price_studio_starter_monthly',
    });
    expect(calls('schedulePlanChange')).toHaveLength(0);
  });

  it('a declined upgrade changes nothing and says payment is needed', async () => {
    await subscribe('studio_starter_monthly');
    fake.declineNextChange = true;
    const outcome = await changePlan(deps(), {
      ...who(),
      next: { plan: 'growth', interval: 'month' },
    });
    expect(outcome).toEqual({ status: 'payment_required', timing: 'now' });
    expect((await entitlements().forOrganisation(org)).plan?.id).toBe('starter');
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan?.paymentPending).toBe(true);
  });

  it('cancel at period end (dropping a scheduled change), resume, and the guards', async () => {
    await subscribe('studio_pro_monthly');
    await changePlan(deps(), { ...who(), next: { plan: 'growth', interval: 'month' } });
    expect(await cancelPlan(deps(), who())).toEqual({ endsAt: PERIOD_END.toISOString() });
    expect(calls('releaseSchedule')).toHaveLength(1);
    expect(calls('setCancelAtPeriodEnd')[0]?.args.slice(0, 2)).toEqual([subId, true]);
    // Changing the plan while it is set to end is refused: resume first.
    await expect(
      changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'year' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await resumePlan(deps(), who());
    expect(calls('setCancelAtPeriodEnd')[1]?.args.slice(0, 2)).toEqual([subId, false]);
    await expect(resumePlan(deps(), who())).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses without a plan, while payment is overdue, and an unknown plan or interval', async () => {
    await expect(
      previewPlanChange(deps(), org, { plan: 'growth', interval: 'month' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await subscribe('studio_growth_monthly', 'past_due');
    await expect(
      changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      previewPlanChange(deps(), org, { plan: 'enterprise' as PlanId, interval: 'month' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'day' as PlanInterval } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a legacy 21.5 channel subscription is shown as its plan (3 channels = Growth) and moves to quantity 1', async () => {
    await subscribe('studio_channel_monthly', 'active', 3);
    const ent = await entitlements().forOrganisation(org);
    expect(ent.plan).toEqual({ id: 'growth', interval: 'month', source: 'stripe' });
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan).toMatchObject({ id: 'growth', legacy: true, pricePerPeriodPence: 8_700 });
    const preview = await previewPlanChange(deps(), org, { plan: 'pro', interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'now',
      current: { plan: 'growth', interval: 'month' },
    });
    await changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'month' } });
    expect(calls('changePlanNow')[0]?.args[0]).toMatchObject({
      priceId: 'price_studio_pro_monthly',
      quantity: 1,
    });
    // Choosing the plan the subscription is now on: that is already the plan.
    await expect(
      changePlan(deps(), { ...who(), next: { plan: 'pro', interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('a legacy tier subscription is shown and changed as its plan (Standard = Growth)', async () => {
    await subscribe('studio_standard_monthly');
    const preview = await previewPlanChange(deps(), org, { plan: 'pro', interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'now',
      current: { plan: 'growth', interval: 'month' },
    });
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan).toMatchObject({ id: 'growth', legacy: true });
    expect(JSON.stringify(overview)).not.toMatch(/costPence|capPence|spent/);
  });
});
