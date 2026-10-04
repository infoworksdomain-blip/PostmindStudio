import type Stripe from 'stripe';
import { planForLookupKey } from './catalogue';
import {
  CHANNEL_LOOKUP_KEYS,
  channelIntervalForLookupKey,
  LEGACY_TIER_CHANNELS,
} from './channel-plan';
import type { SubscriptionState } from './gateway';

// Phase 21.5 — moving the old per-tier TEST-MODE subscriptions to the per-channel plan
// (operator decision 2026-10-04): Basic → 1 channel, Standard → 3, Plus → 6, all monthly
// (studio_channel_monthly, quantity = channels). Run by scripts/billing/migrate-channel-plans.ts;
// pure planning here so it is unit tested. Idempotent: a subscription already on a channel price
// is skipped, so the script can be run again safely.
//
//   Stripe: subscriptions.update items[{id, price, quantity}] with proration_behavior=none (the
//   operator moves test customers; nobody is credited or charged for the switch itself). A
//   yearly legacy subscription moves to monthly too: a different interval starts a new billing
//   period on the day of the change ("the new price is billed at the new interval, starting on
//   the day of the change", https://docs.stripe.com/billing/subscriptions/change-price, read
//   2026-10-04), so its first monthly invoice is raised then. A schedule left by the old portal
//   (a downgrade at period end) is released first, or its next phase would undo the move
//   (https://docs.stripe.com/billing/subscriptions/subscription-schedules, read 2026-10-04).

/** Statuses that are over: nothing to migrate. */
const ENDED = new Set(['canceled', 'incomplete_expired']);

export type MigrationAction =
  'migrate' | 'skip_already_channel' | 'skip_ended' | 'skip_not_self_serve' | 'skip_no_item';

export interface MigrationStep {
  subscriptionId: string;
  customerId: string;
  status: string;
  fromLookupKey: string | null;
  action: MigrationAction;
  /** For 'migrate': the channels and the monthly channel price's lookup key. */
  channels?: number;
  toLookupKey?: string;
  itemId?: string;
  scheduleId?: string | null;
}

export function planChannelMigration(subscriptions: readonly SubscriptionState[]): MigrationStep[] {
  return subscriptions.map((sub): MigrationStep => {
    const base = {
      subscriptionId: sub.id,
      customerId: sub.customerId,
      status: sub.status,
      fromLookupKey: sub.lookupKey,
    };
    if (ENDED.has(sub.status)) return { ...base, action: 'skip_ended' };
    if (channelIntervalForLookupKey(sub.lookupKey))
      return { ...base, action: 'skip_already_channel' };
    const legacy = sub.lookupKey ? planForLookupKey(sub.lookupKey) : undefined;
    if (!legacy || legacy.tier === 'ENTERPRISE') return { ...base, action: 'skip_not_self_serve' };
    if (!sub.itemId) return { ...base, action: 'skip_no_item' };
    return {
      ...base,
      action: 'migrate',
      channels: LEGACY_TIER_CHANNELS[legacy.tier],
      toLookupKey: CHANNEL_LOOKUP_KEYS.month,
      itemId: sub.itemId,
      scheduleId: sub.scheduleId,
    };
  });
}

/** The subscription update that moves one legacy subscription (no proration). */
export function migrationUpdateParams(
  step: MigrationStep,
  monthlyPriceId: string,
): Stripe.SubscriptionUpdateParams {
  if (step.action !== 'migrate' || !step.itemId || !step.channels)
    throw new RangeError(`Subscription ${step.subscriptionId} is not to be migrated`);
  return {
    items: [{ id: step.itemId, price: monthlyPriceId, quantity: step.channels }],
    proration_behavior: 'none',
    metadata: { studio_migrated_from: step.fromLookupKey ?? '', studio_migration: '21.5' },
  };
}

/** Stripe Idempotency-Key per subscription: a re-run never applies the same update twice. */
export function migrationIdempotencyKey(subscriptionId: string): string {
  return `studio-migrate-21-5-${subscriptionId}`;
}
