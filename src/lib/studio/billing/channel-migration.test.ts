import { describe, expect, it } from 'vitest';
import {
  migrationIdempotencyKey,
  migrationUpdateParams,
  planChannelMigration,
} from './channel-migration';
import type { SubscriptionState } from './gateway';

function sub(id: string, lookupKey: string | null, status = 'active'): SubscriptionState {
  return {
    id,
    customerId: `cus_${id}`,
    status,
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
  };
}

describe('legacy tier → channel plan migration (21.5 ops)', () => {
  it('Basic → 1, Standard → 3, Plus → 6 channels, all on the monthly channel price', () => {
    const steps = planChannelMigration([
      sub('a', 'studio_basic_monthly'),
      sub('b', 'studio_standard_yearly', 'trialing'),
      sub('c', 'studio_plus_monthly', 'past_due'),
    ]);
    expect(steps.map((s) => [s.subscriptionId, s.action, s.channels, s.toLookupKey])).toEqual([
      ['a', 'migrate', 1, 'studio_channel_monthly'],
      ['b', 'migrate', 3, 'studio_channel_monthly'],
      ['c', 'migrate', 6, 'studio_channel_monthly'],
    ]);
  });

  it('is idempotent: channel subscriptions, ended ones and ENTERPRISE are skipped', () => {
    const ended = sub('d', 'studio_basic_monthly', 'canceled');
    const steps = planChannelMigration([
      sub('a', 'studio_channel_monthly'),
      ended,
      { ...sub('e', null), productTier: 'ENTERPRISE' },
      { ...sub('f', 'studio_plus_yearly'), itemId: null },
      sub('g', 'studio_basic_monthly', 'incomplete_expired'),
    ]);
    expect(steps.map((s) => s.action)).toEqual([
      'skip_already_channel',
      'skip_ended',
      'skip_not_self_serve',
      'skip_no_item',
      'skip_ended',
    ]);
  });

  it('keeps a schedule id so the script releases it first', () => {
    const [step] = planChannelMigration([
      { ...sub('a', 'studio_standard_monthly'), scheduleId: 'sub_sched_1' },
    ]);
    expect(step?.scheduleId).toBe('sub_sched_1');
  });

  it('updates the item with the channel quantity and no proration', () => {
    const [step] = planChannelMigration([sub('a', 'studio_plus_monthly')]);
    expect(migrationUpdateParams(step!, 'price_channel_monthly')).toEqual({
      items: [{ id: 'si_a', price: 'price_channel_monthly', quantity: 6 }],
      proration_behavior: 'none',
      metadata: { studio_migrated_from: 'studio_plus_monthly', studio_migration: '21.5' },
    });
    const [skipped] = planChannelMigration([sub('b', 'studio_channel_monthly')]);
    expect(() => migrationUpdateParams(skipped!, 'p')).toThrow(RangeError);
    expect(migrationIdempotencyKey('sub_1')).toBe('studio-migrate-21-5-sub_1');
  });
});
