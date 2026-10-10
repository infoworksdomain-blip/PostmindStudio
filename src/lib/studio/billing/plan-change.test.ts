import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStripe, type FakeStripe } from '../../../../test/helpers/fake-stripe';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { changePlan, previewPlanChange, type PlanChangeDeps } from './plan-change';

// 26.3 (security review): the client's prorationDate is bounded (no future, no stale, never
// before the period started), the Stripe idempotency key is derived from the change itself so a
// double submit is one Stripe write, the live plan is re-checked before writing, and a missing
// Stripe price never shows its lookup key to the customer. No database: the subscription row is
// served by a stub, the post-write resync fails quietly (it is logged and left to the webhook).

const NOW = Date.parse('2026-10-10T12:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);
const PERIOD_START = new Date('2026-10-01T00:00:00Z');
const ORG = 'org-pc-unit';
const SUB = 'sub_pc_unit';

describe('plan changes: proration date, idempotency, live re-check (26.3)', () => {
  let fake: FakeStripe;
  let lookupKey: string;
  let warnings: string[];

  function deps(): PlanChangeDeps {
    const row = () => ({
      id: SUB,
      stripeCustomerId: 'cus_unit',
      status: 'active',
      lookupKey,
      productTier: null,
      quantity: 1,
      scheduleId: null,
      cancelAtPeriodEnd: false,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      trialEnd: null,
      createdAt: PERIOD_START,
    });
    const db = { subscription: { findMany: async () => [row()] } };
    const logger = pino({ level: 'warn' }, { write: (line: string) => warnings.push(line) });
    return {
      db: db as unknown as PrismaClient,
      gateway: fake,
      logger,
      audit: () => undefined,
      now: () => NOW,
      env: {},
    };
  }

  beforeEach(() => {
    fake = createFakeStripe();
    lookupKey = 'studio_starter_monthly';
    warnings = [];
    fake.setSubscription({
      id: SUB,
      customerId: 'cus_unit',
      lookupKey,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
    });
  });

  const upgrade = (prorationDate: number | null) =>
    changePlan(deps(), {
      organisationId: ORG,
      userId: 'owner-1',
      next: { plan: 'pro', interval: 'month' },
      prorationDate,
    });
  const writes = () =>
    fake.calls.filter((c) => c.method === 'changePlanNow' || c.method === 'schedulePlanChange');

  describe('prorationDate from the client', () => {
    it('a future value is refused (400) and nothing reaches Stripe', async () => {
      await expect(upgrade(NOW_SEC + 3_600)).rejects.toBeInstanceOf(ValidationError);
      expect(writes()).toHaveLength(0);
    });

    it('a value more than 30 minutes old is refused', async () => {
      await expect(upgrade(NOW_SEC - 31 * 60)).rejects.toBeInstanceOf(ValidationError);
      expect(writes()).toHaveLength(0);
    });

    it('a value before the current period started is refused', async () => {
      // A period that started 10 minutes ago: 20 minutes back is recent but outside it.
      fake.setSubscription({
        id: SUB,
        customerId: 'cus_unit',
        lookupKey,
        currentPeriodStart: new Date(NOW - 10 * 60_000),
        currentPeriodEnd: new Date('2026-11-10T00:00:00Z'),
      });
      await expect(upgrade(NOW_SEC - 20 * 60)).rejects.toBeInstanceOf(ValidationError);
      expect(writes()).toHaveLength(0);
    });

    it('a recent value (and a small clock skew ahead) is sent to Stripe as is', async () => {
      await upgrade(NOW_SEC - 5 * 60);
      expect(fake.calls.find((c) => c.method === 'changePlanNow')?.args[0]).toMatchObject({
        prorationDate: NOW_SEC - 5 * 60,
      });
      fake = createFakeStripe();
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      await upgrade(NOW_SEC + 30);
      expect(fake.calls.find((c) => c.method === 'changePlanNow')?.args[0]).toMatchObject({
        prorationDate: NOW_SEC + 30,
      });
    });

    it('no value: now', async () => {
      await upgrade(null);
      expect(fake.calls.find((c) => c.method === 'changePlanNow')?.args[0]).toMatchObject({
        prorationDate: NOW_SEC,
      });
    });
  });

  describe('double submit', () => {
    it('two identical changes send the same Stripe idempotency key', async () => {
      await upgrade(NOW_SEC - 60);
      // The second request read the subscription before the first one's write landed.
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      await upgrade(NOW_SEC - 60);
      const keys = fake.calls.filter((c) => c.method === 'changePlanNow').map((c) => c.args[1]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toEqual(keys[1]);
      expect(keys[0]).toMatch(/^studio-plan_now-[0-9a-f]{40}$/);
    });

    it('a different change (another proration time or plan) gets another key', async () => {
      await upgrade(NOW_SEC - 60);
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      await upgrade(NOW_SEC - 120);
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      await changePlan(deps(), {
        organisationId: ORG,
        userId: 'owner-1',
        next: { plan: 'growth', interval: 'month' },
        prorationDate: NOW_SEC - 60,
      });
      const keys = fake.calls.filter((c) => c.method === 'changePlanNow').map((c) => c.args[1]);
      expect(new Set(keys).size).toBe(3);
    });

    it('two identical scheduled downgrades send the same key', async () => {
      lookupKey = 'studio_pro_monthly';
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      const down = () =>
        changePlan(deps(), {
          organisationId: ORG,
          userId: 'owner-1',
          next: { plan: 'starter', interval: 'month' },
        });
      await down();
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey });
      await down();
      const keys = fake.calls
        .filter((c) => c.method === 'schedulePlanChange')
        .map((c) => c.args[1]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toEqual(keys[1]);
    });

    it('the live subscription already on the target plan: no Stripe write (409)', async () => {
      // Our row still says Starter; Stripe already moved to Pro (the first request won).
      fake.setSubscription({ id: SUB, customerId: 'cus_unit', lookupKey: 'studio_pro_monthly' });
      await expect(upgrade(NOW_SEC - 60)).rejects.toBeInstanceOf(ConflictError);
      expect(writes()).toHaveLength(0);
    });
  });

  describe('a missing Stripe price', () => {
    it('says so without the lookup key; the key is logged', async () => {
      fake.prices = fake.prices.filter((p) => p.lookupKey !== 'studio_pro_monthly');
      const err = await upgrade(null).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe(
        "This plan isn't available right now. Please try again later.",
      );
      expect(JSON.stringify(err)).not.toContain('studio_pro_monthly');
      expect(warnings.join('\n')).toContain('studio_pro_monthly');
      const preview = await previewPlanChange(deps(), ORG, {
        plan: 'pro',
        interval: 'month',
      }).catch((e: unknown) => e);
      expect((preview as Error).message).not.toContain('studio_');
    });
  });
});
