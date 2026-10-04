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
import { syncSubscription } from '../../src/lib/studio/billing/sync';
import { createFakeStripe, type FakeStripe } from '../helpers/fake-stripe';

// 21.5 Your plan on real Postgres with a scripted Stripe: previews, upgrades now with proration
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
    quantity: number,
    lookupKey = 'studio_channel_monthly',
    status = 'active',
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

  it('upgrade: preview shows the prorated amount due now; the change sends that proration time', async () => {
    await subscribe(2);
    fake.previewAmountPence = 1_160;
    const preview = await previewPlanChange(deps(), org, { channels: 3, interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'now',
      current: { channels: 2, interval: 'month' },
      next: { channels: 3, interval: 'month' },
      nextPricePence: 8_700,
      dueNowPence: 1_160,
      prorationDate: Math.floor(NOW / 1000),
    });
    expect(calls('previewPlanChange')[0]?.args[0]).toMatchObject({
      customerId: `cus_${org}`,
      subscriptionId: subId,
      itemId: `si_${subId}`,
      priceId: 'price_studio_channel_monthly',
      quantity: 3,
    });

    const outcome = await changePlan(deps(), {
      ...who(),
      next: { channels: 3, interval: 'month' },
      prorationDate: preview.prorationDate,
    });
    expect(outcome).toEqual({ status: 'applied', timing: 'now' });
    expect(calls('changePlanNow')[0]?.args[0]).toMatchObject({
      quantity: 3,
      prorationDate: Math.floor(NOW / 1000),
    });
    const ent = await entitlements().forOrganisation(org);
    expect(ent.channelPlan).toEqual({ channels: 3, interval: 'month', source: 'stripe' });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: 'billing.subscription_changed',
        metadata: expect.objectContaining({ change: 'channel_plan', timing: 'now' }),
      }),
    );
  });

  it('downgrade: applies at the end of the period (a schedule), shown as the pending change', async () => {
    await subscribe(3);
    const preview = await previewPlanChange(deps(), org, { channels: 1, interval: 'month' });
    expect(preview).toMatchObject({
      timing: 'period_end',
      effectiveAt: PERIOD_END.toISOString(),
      dueNowPence: null,
      nextPricePence: 2_900,
    });
    expect(calls('previewPlanChange')).toHaveLength(0);
    const outcome = await changePlan(deps(), {
      ...who(),
      next: { channels: 1, interval: 'month' },
    });
    expect(outcome).toEqual({
      status: 'scheduled',
      timing: 'period_end',
      effectiveAt: PERIOD_END.toISOString(),
    });
    // Still 3 channels until the period ends.
    expect((await entitlements().forOrganisation(org)).channelPlan?.channels).toBe(3);
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan).toMatchObject({
      channels: 3,
      interval: 'month',
      pricePerPeriodPence: 8_700,
      pending: { channels: 1, interval: 'month', effectiveAt: PERIOD_END.toISOString() },
    });

    // Keep the current plan: the schedule is released and nothing is pending.
    await cancelScheduledChange(deps(), who());
    expect(calls('releaseSchedule')).toHaveLength(1);
    const after = await billingOverview({ db, entitlements: entitlements(), now: () => NOW }, org);
    expect(after.plan?.pending).toBeNull();
    await expect(cancelScheduledChange(deps(), who())).rejects.toBeInstanceOf(ConflictError);
  });

  it('a longer period applies now, a shorter one at period end; an upgrade drops a scheduled change', async () => {
    await subscribe(2);
    expect((await previewPlanChange(deps(), org, { channels: 2, interval: 'year' })).timing).toBe(
      'now',
    );
    expect((await previewPlanChange(deps(), org, { channels: 2, interval: 'week' })).timing).toBe(
      'period_end',
    );
    await changePlan(deps(), { ...who(), next: { channels: 2, interval: 'week' } });
    expect(calls('schedulePlanChange')[0]?.args[0]).toMatchObject({
      interval: 'week',
      priceId: 'price_studio_channel_weekly',
      organisationId: org,
    });
    await changePlan(deps(), { ...who(), next: { channels: 4, interval: 'month' } });
    expect(calls('releaseSchedule')).toHaveLength(1);
    const ent = await entitlements().forOrganisation(org);
    expect(ent.channelPlan?.channels).toBe(4);
    await expect(
      changePlan(deps(), { ...who(), next: { channels: 4, interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('a trial changes at once with no proration (nothing is charged until it ends)', async () => {
    await subscribe(3, 'studio_channel_monthly', 'trialing');
    const preview = await previewPlanChange(deps(), org, { channels: 1, interval: 'month' });
    expect(preview).toMatchObject({ timing: 'now', dueNowPence: 0, prorationDate: null });
    await changePlan(deps(), { ...who(), next: { channels: 1, interval: 'month' } });
    expect(calls('changePlanNow')[0]?.args[0]).toMatchObject({ prorationDate: null, quantity: 1 });
    expect(calls('schedulePlanChange')).toHaveLength(0);
  });

  it('a declined upgrade changes nothing and says payment is needed', async () => {
    await subscribe(1);
    fake.declineNextChange = true;
    const outcome = await changePlan(deps(), {
      ...who(),
      next: { channels: 2, interval: 'month' },
    });
    expect(outcome).toEqual({ status: 'payment_required', timing: 'now' });
    expect((await entitlements().forOrganisation(org)).channelPlan?.channels).toBe(1);
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan?.paymentPending).toBe(true);
  });

  it('cancel at period end (dropping a scheduled change), resume, and the guards', async () => {
    await subscribe(3);
    await changePlan(deps(), { ...who(), next: { channels: 2, interval: 'month' } });
    expect(await cancelPlan(deps(), who())).toEqual({ endsAt: PERIOD_END.toISOString() });
    expect(calls('releaseSchedule')).toHaveLength(1);
    expect(calls('setCancelAtPeriodEnd')[0]?.args.slice(0, 2)).toEqual([subId, true]);
    // Changing the plan while it is set to end is refused: resume first.
    await expect(
      changePlan(deps(), { ...who(), next: { channels: 4, interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await resumePlan(deps(), who());
    expect(calls('setCancelAtPeriodEnd')[1]?.args.slice(0, 2)).toEqual([subId, false]);
    await expect(resumePlan(deps(), who())).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses without a plan, while payment is overdue, and outside 1–6 channels', async () => {
    await expect(
      previewPlanChange(deps(), org, { channels: 2, interval: 'month' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await subscribe(2, 'studio_channel_monthly', 'past_due');
    await expect(
      changePlan(deps(), { ...who(), next: { channels: 3, interval: 'month' } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      previewPlanChange(deps(), org, { channels: 7, interval: 'month' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a legacy tier subscription is shown and changed as channels (Standard = 3)', async () => {
    await subscribe(1, 'studio_standard_monthly');
    const preview = await previewPlanChange(deps(), org, { channels: 4, interval: 'month' });
    expect(preview).toMatchObject({ timing: 'now', current: { channels: 3, interval: 'month' } });
    const overview = await billingOverview(
      { db, entitlements: entitlements(), now: () => NOW },
      org,
    );
    expect(overview.plan).toMatchObject({ channels: 3, legacy: true });
    expect(JSON.stringify(overview)).not.toMatch(/costPence|capPence|spent/);
  });
});
