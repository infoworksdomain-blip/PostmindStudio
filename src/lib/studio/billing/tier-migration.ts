import type Stripe from 'stripe';
import { ConfigurationError } from '../../errors';
import { planForLookupKey } from './catalogue';
import type { PriceState, SubscriptionState } from './gateway';
import {
  LEGACY_TIER_PLANS,
  planChoiceForLookupKey,
  planForChannelCount,
  planLookupKey,
  planLookupKeys,
  legacyChannelIntervalForLookupKey,
  type PlanChoice,
} from './plans';

// Phase 26.1 — moving every legacy subscription to the three plans (operator decision
// 2026-10-09). Run by scripts/billing/migrate-to-tiers.ts; the planning and the run loop live here
// so they are unit tested with a fake Stripe client.
//
//   21.5 per-channel price (studio_channel_<interval>, quantity = channels) → the same interval of
//     1 channel → Starter, 2–3 → Growth, 4 or more → Pro.
//   2026-09-30 tier price (studio_<basic|standard|plus>_<interval>, if any is left) → Basic →
//     Starter, Standard → Growth, Plus → Pro, same interval.
//
//   Stripe: subscriptions.update items[{id, price, quantity: 1}] with proration_behavior=none
//   (nobody is credited or charged for the switch itself; the new amount applies from the next
//   invoice). Same interval, so the billing period is not reset
//   (https://docs.stripe.com/billing/subscriptions/change-price). A schedule left by a pending
//   end-of-period change is released first, or its next phase would put the old price back
//   (https://docs.stripe.com/billing/subscriptions/subscription-schedules).
//
// Idempotent: a subscription already on a plan price is skipped, and each Stripe write carries a
// fixed Idempotency-Key per subscription, so the script can be run again safely.

/** Statuses that are over: nothing to migrate. */
const ENDED = new Set(['canceled', 'incomplete_expired']);

export type TierMigrationAction =
  'migrate' | 'skip_already_plan' | 'skip_ended' | 'skip_not_self_serve' | 'skip_no_item';

export interface TierMigrationStep {
  subscriptionId: string;
  customerId: string;
  status: string;
  fromLookupKey: string | null;
  fromQuantity: number;
  action: TierMigrationAction;
  /** For 'migrate': the plan, interval and price lookup key it moves to. */
  to?: PlanChoice & { lookupKey: string };
  itemId?: string;
  scheduleId?: string | null;
}

/** The plan a legacy price maps to (undefined: not a legacy self-serve price). */
function legacyTarget(sub: SubscriptionState): PlanChoice | undefined {
  const channelInterval = legacyChannelIntervalForLookupKey(sub.lookupKey);
  if (channelInterval)
    return { plan: planForChannelCount(sub.quantity), interval: channelInterval };
  const tier = sub.lookupKey ? planForLookupKey(sub.lookupKey) : undefined;
  if (!tier || tier.studioPlan || tier.tier === 'ENTERPRISE') return undefined;
  return { plan: LEGACY_TIER_PLANS[tier.tier], interval: tier.interval };
}

export function planTierMigration(
  subscriptions: readonly SubscriptionState[],
): TierMigrationStep[] {
  return subscriptions.map((sub): TierMigrationStep => {
    const base = {
      subscriptionId: sub.id,
      customerId: sub.customerId,
      status: sub.status,
      fromLookupKey: sub.lookupKey,
      fromQuantity: sub.quantity,
    };
    if (ENDED.has(sub.status)) return { ...base, action: 'skip_ended' };
    if (planChoiceForLookupKey(sub.lookupKey)) return { ...base, action: 'skip_already_plan' };
    const target = legacyTarget(sub);
    if (!target) return { ...base, action: 'skip_not_self_serve' };
    if (!sub.itemId) return { ...base, action: 'skip_no_item' };
    return {
      ...base,
      action: 'migrate',
      to: { ...target, lookupKey: planLookupKey(target.plan, target.interval) },
      itemId: sub.itemId,
      scheduleId: sub.scheduleId,
    };
  });
}

/** The subscription update that moves one legacy subscription (quantity 1, no proration). */
export function tierMigrationUpdateParams(
  step: TierMigrationStep,
  priceId: string,
): Stripe.SubscriptionUpdateParams {
  if (step.action !== 'migrate' || !step.itemId || !step.to)
    throw new RangeError(`Subscription ${step.subscriptionId} is not to be migrated`);
  return {
    items: [{ id: step.itemId, price: priceId, quantity: 1 }],
    proration_behavior: 'none',
    metadata: {
      studio_migrated_from: step.fromLookupKey ?? '',
      studio_migrated_quantity: String(step.fromQuantity),
      studio_migration: '26.1',
    },
  };
}

/** Stripe Idempotency-Key per subscription: a re-run never applies the same update twice. */
export function tierMigrationIdempotencyKey(subscriptionId: string): string {
  return `studio-migrate-26-1-${subscriptionId}`;
}

/** The Stripe calls the migration makes (the script wires the real client; tests a fake). */
export interface TierMigrationClient {
  listSubscriptions(): AsyncIterable<SubscriptionState>;
  listPrices(lookupKeys: string[]): Promise<PriceState[]>;
  releaseSchedule(scheduleId: string, idempotencyKey: string): Promise<void>;
  updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
    idempotencyKey: string,
  ): Promise<SubscriptionState>;
}

export interface TierMigrationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface TierMigrationResult {
  apply: boolean;
  counts: Partial<Record<TierMigrationAction, number>>;
  steps: TierMigrationStep[];
}

/**
 * Plan every subscription and, with `apply`, move the legacy ones. `onMigrated` stores the
 * updated subscription (the script syncs studio.subscriptions + org_entitlements) and returns the
 * organisation id, or null when this database does not know the customer.
 */
export async function runTierMigration(deps: {
  client: TierMigrationClient;
  apply: boolean;
  logger: TierMigrationLogger;
  onMigrated?: (state: SubscriptionState) => Promise<string | null>;
}): Promise<TierMigrationResult> {
  const { client, apply, logger } = deps;
  const prices = new Map(
    (await client.listPrices(planLookupKeys()))
      .filter((p) => p.active && p.lookupKey)
      .map((p) => [p.lookupKey as string, p.id]),
  );
  const subscriptions: SubscriptionState[] = [];
  for await (const sub of client.listSubscriptions()) subscriptions.push(sub);
  const steps = planTierMigration(subscriptions);
  const counts: TierMigrationResult['counts'] = {};
  for (const step of steps) {
    counts[step.action] = (counts[step.action] ?? 0) + 1;
    if (step.action !== 'migrate' || !step.to) {
      logger.info({ subscription: step.subscriptionId, action: step.action }, 'skipped');
      continue;
    }
    const priceId = prices.get(step.to.lookupKey);
    if (!priceId)
      throw new ConfigurationError(
        `No active price has the lookup key ${step.to.lookupKey}: run seed-stripe-test.ts first`,
      );
    const summary = {
      subscription: step.subscriptionId,
      from: step.fromLookupKey,
      fromQuantity: step.fromQuantity,
      to: step.to.lookupKey,
      releaseSchedule: step.scheduleId ?? null,
    };
    if (!apply) {
      logger.info(summary, '[dry-run] would migrate');
      continue;
    }
    const key = tierMigrationIdempotencyKey(step.subscriptionId);
    if (step.scheduleId) await client.releaseSchedule(step.scheduleId, `${key}-release`);
    const updated = await client.updateSubscription(
      step.subscriptionId,
      tierMigrationUpdateParams(step, priceId),
      key,
    );
    const organisationId = deps.onMigrated ? await deps.onMigrated(updated) : null;
    logger.info(
      { ...summary, organisationId },
      organisationId ? 'migrated and synced' : 'migrated (customer not known to this database)',
    );
  }
  return { apply, counts, steps };
}
