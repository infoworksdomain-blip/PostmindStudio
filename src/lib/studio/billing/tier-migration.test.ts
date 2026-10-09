import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import type { PriceState, SubscriptionState } from './gateway';
import { planLookupKeys } from './plans';
import {
  planTierMigration,
  runTierMigration,
  tierMigrationIdempotencyKey,
  tierMigrationUpdateParams,
  type TierMigrationClient,
} from './tier-migration';

function sub(
  id: string,
  lookupKey: string | null,
  extra: Partial<SubscriptionState> = {},
): SubscriptionState {
  return {
    id,
    customerId: `cus_${id}`,
    status: 'active',
    lookupKey,
    priceId: `price_${lookupKey}`,
    itemId: `si_${id}`,
    scheduleId: null,
    pendingChange: null,
    hasPendingUpdate: false,
    productTier: null,
    interval: 'month',
    unitAmountPence: 2_900,
    quantity: 1,
    currency: 'gbp',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEnd: null,
    metadataOrganisationId: null,
    defaultPaymentMethodId: null,
    created: new Date('2026-09-01T00:00:00Z'),
    ...extra,
  };
}

describe('planTierMigration (26.1)', () => {
  it('maps channel subscriptions by quantity and keeps the interval', () => {
    const steps = planTierMigration([
      sub('a', 'studio_channel_monthly', { quantity: 1 }),
      sub('b', 'studio_channel_weekly', { quantity: 2, status: 'trialing' }),
      sub('c', 'studio_channel_yearly', { quantity: 3, status: 'past_due' }),
      sub('d', 'studio_channel_monthly', { quantity: 4 }),
      sub('e', 'studio_channel_monthly', { quantity: 6 }),
    ]);
    expect(steps.map((s) => [s.subscriptionId, s.action, s.to?.lookupKey])).toEqual([
      ['a', 'migrate', 'studio_starter_monthly'],
      ['b', 'migrate', 'studio_growth_weekly'],
      ['c', 'migrate', 'studio_growth_yearly'],
      ['d', 'migrate', 'studio_pro_monthly'],
      ['e', 'migrate', 'studio_pro_monthly'],
    ]);
  });

  it('maps any 2026-09-30 tier price left: Basic → Starter, Standard → Growth, Plus → Pro', () => {
    const steps = planTierMigration([
      sub('a', 'studio_basic_monthly'),
      sub('b', 'studio_standard_yearly'),
      sub('c', 'studio_plus_monthly'),
    ]);
    expect(steps.map((s) => s.to?.lookupKey)).toEqual([
      'studio_starter_monthly',
      'studio_growth_yearly',
      'studio_pro_monthly',
    ]);
  });

  it('skips plan prices (idempotent), ended, ENTERPRISE / unknown and item-less subscriptions', () => {
    const steps = planTierMigration([
      sub('a', 'studio_growth_monthly'),
      sub('b', 'studio_channel_monthly', { status: 'canceled' }),
      sub('c', null, { productTier: 'ENTERPRISE' }),
      sub('d', 'studio_channel_monthly', { itemId: null }),
      sub('e', 'something_else'),
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      'skip_already_plan',
      'skip_ended',
      'skip_not_self_serve',
      'skip_no_item',
      'skip_not_self_serve',
    ]);
  });

  it('updates the one item to the plan price with quantity 1 and no proration', () => {
    const [step] = planTierMigration([sub('a', 'studio_channel_monthly', { quantity: 3 })]);
    expect(tierMigrationUpdateParams(step!, 'price_growth_monthly')).toEqual({
      items: [{ id: 'si_a', price: 'price_growth_monthly', quantity: 1 }],
      proration_behavior: 'none',
      metadata: {
        studio_migrated_from: 'studio_channel_monthly',
        studio_migrated_quantity: '3',
        studio_migration: '26.1',
      },
    });
    expect(tierMigrationIdempotencyKey('sub_1')).toBe('studio-migrate-26-1-sub_1');
    const [skipped] = planTierMigration([sub('b', 'studio_pro_monthly')]);
    expect(() => tierMigrationUpdateParams(skipped!, 'price_x')).toThrow(RangeError);
  });
});

/** A fake Stripe: subscriptions in memory; updates swap the price like Stripe would. */
function fakeClient(initial: SubscriptionState[], priceKeys = planLookupKeys()) {
  const subs = new Map(initial.map((s) => [s.id, s]));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const prices: PriceState[] = priceKeys.map((lookupKey) => ({
    id: `price_${lookupKey}`,
    lookupKey,
    unitAmountPence: 100,
    currency: 'gbp',
    interval: 'month',
    active: true,
    productName: null,
    productTier: 'STANDARD',
    taxBehavior: 'exclusive',
  }));
  const client: TierMigrationClient = {
    async *listSubscriptions() {
      for (const s of subs.values()) yield s;
    },
    async listPrices(keys) {
      calls.push({ method: 'listPrices', args: [keys] });
      return prices.filter((p) => p.lookupKey && keys.includes(p.lookupKey));
    },
    async releaseSchedule(scheduleId, idempotencyKey) {
      calls.push({ method: 'releaseSchedule', args: [scheduleId, idempotencyKey] });
      for (const s of subs.values())
        if (s.scheduleId === scheduleId) subs.set(s.id, { ...s, scheduleId: null });
    },
    async updateSubscription(id, params: Stripe.SubscriptionUpdateParams, idempotencyKey) {
      calls.push({ method: 'updateSubscription', args: [id, params, idempotencyKey] });
      const current = subs.get(id)!;
      const item = params.items?.[0];
      const priceId = String(item?.price);
      const lookupKey = prices.find((p) => p.id === priceId)?.lookupKey ?? null;
      const next = { ...current, priceId, lookupKey, quantity: Number(item?.quantity ?? 1) };
      subs.set(id, next);
      return next;
    },
  };
  return { client, calls, subs };
}

const logger = { info: () => undefined };

describe('runTierMigration (scripts/billing/migrate-to-tiers.ts)', () => {
  it('dry run (default) plans every subscription and writes nothing', async () => {
    const fake = fakeClient([
      sub('a', 'studio_channel_monthly', { quantity: 2 }),
      sub('b', 'studio_pro_yearly'),
    ]);
    const result = await runTierMigration({ client: fake.client, apply: false, logger });
    expect(result.counts).toEqual({ migrate: 1, skip_already_plan: 1 });
    expect(fake.calls.map((c) => c.method)).toEqual(['listPrices']);
    expect(fake.subs.get('a')?.lookupKey).toBe('studio_channel_monthly');
  });

  it('--apply releases a schedule first, moves the subscription and syncs it; a re-run is a no-op', async () => {
    const fake = fakeClient([
      sub('a', 'studio_channel_weekly', { quantity: 5, scheduleId: 'sub_sched_a' }),
      sub('b', 'studio_channel_monthly', { quantity: 1 }),
    ]);
    const synced: string[] = [];
    const onMigrated = async (state: SubscriptionState) => {
      synced.push(`${state.id}:${state.lookupKey}:${state.quantity}`);
      return `org_${state.id}`;
    };
    const first = await runTierMigration({ client: fake.client, apply: true, logger, onMigrated });
    expect(first.counts).toEqual({ migrate: 2 });
    expect(fake.calls.map((c) => c.method)).toEqual([
      'listPrices',
      'releaseSchedule',
      'updateSubscription',
      'updateSubscription',
    ]);
    expect(fake.calls[1]?.args).toEqual(['sub_sched_a', 'studio-migrate-26-1-a-release']);
    expect(fake.calls[2]?.args[1]).toMatchObject({
      items: [{ id: 'si_a', price: 'price_studio_pro_weekly', quantity: 1 }],
      proration_behavior: 'none',
    });
    expect(fake.calls[2]?.args[2]).toBe('studio-migrate-26-1-a');
    expect(synced).toEqual(['a:studio_pro_weekly:1', 'b:studio_starter_monthly:1']);

    const second = await runTierMigration({ client: fake.client, apply: true, logger, onMigrated });
    expect(second.counts).toEqual({ skip_already_plan: 2 });
    expect(fake.calls.filter((c) => c.method === 'updateSubscription')).toHaveLength(2);
  });

  it('refuses to move a subscription when its plan price is missing (seed first)', async () => {
    const fake = fakeClient(
      [sub('a', 'studio_channel_monthly', { quantity: 3 })],
      ['studio_starter_monthly'],
    );
    await expect(runTierMigration({ client: fake.client, apply: true, logger })).rejects.toThrow(
      ConfigurationError,
    );
    expect(fake.calls.some((c) => c.method === 'updateSubscription')).toBe(false);
  });
});
