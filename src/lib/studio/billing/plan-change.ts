import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AuditAction } from '../../audit-sink';
import { ConflictError, NotFoundError } from '../../errors';
import { planForLookupKey } from './catalogue';
import {
  assertPlanChoice,
  LEGACY_TIER_PLANS,
  planChangeTiming,
  planLookupKey,
  planOfSubscription,
  type PlanChangeTiming,
  type PlanChoice,
  type PlanId,
  type PlanInterval,
} from './plans';
import type { StripeGateway, SubscriptionState } from './gateway';
import { governingSubscription, syncSubscription, type BillingSyncDeps } from './sync';

// Phase 21.5 / 26.1 — "Your plan": change the plan (Starter / Growth / Pro) and interval, cancel
// and resume, all from Studio (the Stripe Customer Portal is kept for payment methods and
// invoices only). The subscription keeps one item; a change swaps its price, quantity 1 (a
// legacy 21.5 channel subscription's quantity goes back to 1 with it).
//
//   Rules (operator decision 2026-10-04, kept in 26.1): upgrades apply NOW with proration
//   (invoiced at once, applied once paid); downgrades apply at the END of the period (a
//   subscription schedule). What counts as which: plans.ts planChangeTiming (a higher plan is an
//   upgrade; on the same plan a longer interval is). While the subscription is trialing
//   every change applies now with no proration: nothing is charged until the trial ends, and the
//   first invoice is for the plan chosen by then.
//
//   One pending change at a time. A new change replaces a scheduled one; cancelling drops it;
//   an upgrade "now" releases it first (its end-of-period change would otherwise overwrite the
//   upgrade at the next phase).
//
// After every Stripe write the subscription is re-fetched and synced (sync.ts), so the page and
// the entitlements show the result at once instead of waiting for the webhook (which still
// arrives and is idempotent).

export interface PlanChangeDeps extends BillingSyncDeps {
  gateway: StripeGateway;
}

/** Subscription statuses whose plan the customer may change. */
const CHANGEABLE = new Set(['active', 'trialing']);

export interface CurrentPlan {
  subscriptionId: string;
  customerId: string;
  itemId: string | null;
  status: string;
  plan: PlanId;
  interval: PlanInterval;
  /** A legacy price (21.5 channels by quantity, or an old tier) mapped to a plan. */
  legacy: boolean;
  scheduleId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
}

export interface PlanChangePreviewView {
  timing: PlanChangeTiming;
  current: PlanChoice;
  next: PlanChoice;
  /** The new plan's price per period (excl. VAT), from the live Stripe price. */
  nextPricePence: number;
  currency: string;
  /** When the change applies: now, or the end of the current period. */
  effectiveAt: string | null;
  /** Immediate changes: the prorated amount invoiced now (incl. VAT when Stripe Tax applies). */
  dueNowPence: number | null;
  /** Echo it back with the change so Stripe prorates exactly what was shown. */
  prorationDate: number | null;
}

export type PlanChangeOutcome =
  | { status: 'applied'; timing: 'now' }
  | { status: 'scheduled'; timing: 'period_end'; effectiveAt: string | null }
  /** The upgrade's invoice could not be paid: nothing changed until it is (pending_update). */
  | { status: 'payment_required'; timing: 'now' };

/**
 * A fresh Stripe Idempotency-Key per write (the route's own Idempotency-Key replays a double
 * click); the same shape as service.ts idempotencyKey: studio-<intent>-<digest>.
 */
function stripeKey(organisationId: string, intent: string): string {
  const digest = createHash('sha256')
    .update(`${organisationId}|${intent}|${randomBytes(12).toString('hex')}`)
    .digest('hex');
  return `studio-${intent}-${digest.slice(0, 40)}`;
}

/** The plan a subscription row pays for: a plan price, or a legacy price mapped to a plan. */
function planOfRow(sub: {
  lookupKey: string | null;
  quantity: number;
}): (PlanChoice & { legacy: boolean }) | null {
  const found = planOfSubscription(sub);
  if (found) return found;
  const tier = sub.lookupKey ? planForLookupKey(sub.lookupKey) : undefined;
  if (!tier || tier.tier === 'ENTERPRISE') return null;
  return { plan: LEGACY_TIER_PLANS[tier.tier], interval: tier.interval, legacy: true };
}

/** The governing subscription as a plan (legacy prices mapped by the 26.1 rules). */
export async function currentPlan(
  db: Pick<PrismaClient, 'subscription'>,
  organisationId: string,
): Promise<CurrentPlan | null> {
  const sub = governingSubscription(await db.subscription.findMany({ where: { organisationId } }));
  if (!sub) return null;
  const found = planOfRow(sub);
  if (!found) return null;
  return {
    subscriptionId: sub.id,
    customerId: sub.stripeCustomerId,
    itemId: null,
    status: sub.status,
    plan: found.plan,
    interval: found.interval,
    legacy: found.legacy,
    scheduleId: sub.scheduleId,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    currentPeriodEnd: sub.currentPeriodEnd,
    trialEnd: sub.trialEnd,
  };
}

async function changeablePlan(deps: PlanChangeDeps, organisationId: string) {
  const plan = await currentPlan(deps.db, organisationId);
  if (!plan) throw new NotFoundError('This organisation has no plan to change; choose one first');
  if (!CHANGEABLE.has(plan.status))
    throw new ConflictError('Fix the payment first, then change the plan', {
      reason: 'subscription_not_changeable',
      subscriptionStatus: plan.status,
    });
  if (plan.cancelAtPeriodEnd)
    throw new ConflictError('Resume the plan before changing it', { reason: 'cancelling' });
  // The item id is not stored: re-fetch the subscription (also the freshest state to act on).
  const live = await deps.gateway.retrieveSubscription(plan.subscriptionId);
  if (!live?.itemId) throw new NotFoundError('Stripe no longer has this subscription');
  return { plan: { ...plan, itemId: live.itemId, scheduleId: live.scheduleId }, live };
}

async function planPrice(gateway: StripeGateway, next: PlanChoice) {
  const lookupKey = planLookupKey(next.plan, next.interval);
  const [price] = (await gateway.listPrices([lookupKey])).filter((p) => p.active);
  if (!price || price.unitAmountPence === null)
    throw new NotFoundError(`No active Stripe price has the lookup key ${lookupKey}`);
  return { id: price.id, unitAmountPence: price.unitAmountPence, currency: price.currency };
}

function timingFor(plan: CurrentPlan, next: PlanChoice): PlanChangeTiming {
  const timing = planChangeTiming(plan, next);
  // A trial is charged nothing until it ends: every change applies at once.
  return timing === 'period_end' && plan.status === 'trialing' ? 'now' : timing;
}

/** What a change would cost and when it would apply (no Stripe write). */
export async function previewPlanChange(
  deps: PlanChangeDeps,
  organisationId: string,
  choice: PlanChoice,
): Promise<PlanChangePreviewView> {
  const next = assertPlanChoice(choice);
  const { plan } = await changeablePlan(deps, organisationId);
  const timing = timingFor(plan, next);
  const price = await planPrice(deps.gateway, next);
  const base = {
    timing,
    current: { plan: plan.plan, interval: plan.interval },
    next,
    nextPricePence: price.unitAmountPence,
    currency: price.currency,
  };
  if (timing === 'none')
    return { ...base, effectiveAt: null, dueNowPence: null, prorationDate: null };
  if (timing === 'period_end' || plan.status === 'trialing')
    return {
      ...base,
      effectiveAt:
        timing === 'now'
          ? new Date(deps.now()).toISOString()
          : (plan.currentPeriodEnd?.toISOString() ?? null),
      dueNowPence: timing === 'now' ? 0 : null,
      prorationDate: null,
    };
  const prorationDate = Math.floor(deps.now() / 1000);
  const preview = await deps.gateway.previewPlanChange({
    customerId: plan.customerId,
    subscriptionId: plan.subscriptionId,
    itemId: plan.itemId,
    priceId: price.id,
    quantity: 1,
    prorationDate,
  });
  return {
    ...base,
    currency: preview.currency,
    effectiveAt: new Date(deps.now()).toISOString(),
    dueNowPence: preview.amountDuePence,
    prorationDate,
  };
}

/** The previewed proration time is used only while it is recent (it must lie in the period). */
const PRORATION_DATE_MAX_AGE_SEC = 30 * 60;

export async function changePlan(
  deps: PlanChangeDeps,
  input: {
    organisationId: string;
    userId: string;
    next: PlanChoice;
    /** From the preview the customer confirmed. */
    prorationDate?: number | null;
  },
): Promise<PlanChangeOutcome> {
  const { organisationId, userId } = input;
  const next = assertPlanChoice(input.next);
  const { plan } = await changeablePlan(deps, organisationId);
  const timing = timingFor(plan, next);
  if (timing === 'none') throw new ConflictError('That is already your plan', { reason: 'same' });
  const price = await planPrice(deps.gateway, next);
  const change = {
    subscriptionId: plan.subscriptionId,
    itemId: plan.itemId,
    priceId: price.id,
    quantity: 1,
  };
  let outcome: PlanChangeOutcome;
  if (timing === 'period_end') {
    await deps.gateway.schedulePlanChange(
      { ...change, scheduleId: plan.scheduleId, interval: next.interval, organisationId },
      stripeKey(organisationId, 'plan_schedule'),
    );
    outcome = {
      status: 'scheduled',
      timing,
      effectiveAt: plan.currentPeriodEnd?.toISOString() ?? null,
    };
  } else {
    if (plan.scheduleId)
      await deps.gateway.releaseSchedule(
        plan.scheduleId,
        stripeKey(organisationId, 'plan_release'),
      );
    const nowSec = Math.floor(deps.now() / 1000);
    const confirmed =
      input.prorationDate && nowSec - input.prorationDate <= PRORATION_DATE_MAX_AGE_SEC
        ? input.prorationDate
        : nowSec;
    const state = await deps.gateway.changePlanNow(
      { ...change, prorationDate: plan.status === 'trialing' ? null : confirmed },
      stripeKey(organisationId, 'plan_now'),
    );
    outcome = state.hasPendingUpdate
      ? { status: 'payment_required', timing }
      : { status: 'applied', timing };
  }
  deps.audit({
    actorUserId: userId,
    organisationId,
    action: AuditAction.BillingSubscriptionChanged,
    resource: { type: 'subscription', id: plan.subscriptionId },
    metadata: {
      change: 'plan',
      from: { plan: plan.plan, interval: plan.interval },
      to: next,
      timing,
      status: outcome.status,
    },
  });
  await resync(deps, plan.subscriptionId, `plan_change:${outcome.status}`);
  return outcome;
}

/** Cancel at the end of the period (a scheduled change is dropped first). */
export async function cancelPlan(
  deps: PlanChangeDeps,
  input: { organisationId: string; userId: string },
): Promise<{ endsAt: string | null }> {
  const plan = await currentPlan(deps.db, input.organisationId);
  if (!plan || (!CHANGEABLE.has(plan.status) && plan.status !== 'past_due'))
    throw new NotFoundError('This organisation has no plan to cancel');
  if (plan.scheduleId)
    await deps.gateway.releaseSchedule(
      plan.scheduleId,
      stripeKey(input.organisationId, 'plan_release'),
    );
  await deps.gateway.setCancelAtPeriodEnd(
    plan.subscriptionId,
    true,
    stripeKey(input.organisationId, 'plan_cancel'),
  );
  deps.audit({
    actorUserId: input.userId,
    organisationId: input.organisationId,
    action: AuditAction.BillingSubscriptionChanged,
    resource: { type: 'subscription', id: plan.subscriptionId },
    metadata: { change: 'cancel_at_period_end' },
  });
  await resync(deps, plan.subscriptionId, 'plan_cancel');
  return { endsAt: (plan.trialEnd ?? plan.currentPeriodEnd)?.toISOString() ?? null };
}

/** Keep the plan: undo a cancellation before the period ends. */
export async function resumePlan(
  deps: PlanChangeDeps,
  input: { organisationId: string; userId: string },
): Promise<void> {
  const plan = await currentPlan(deps.db, input.organisationId);
  if (!plan || !plan.cancelAtPeriodEnd)
    throw new ConflictError('This plan is not set to end', { reason: 'not_cancelling' });
  await deps.gateway.setCancelAtPeriodEnd(
    plan.subscriptionId,
    false,
    stripeKey(input.organisationId, 'plan_resume'),
  );
  deps.audit({
    actorUserId: input.userId,
    organisationId: input.organisationId,
    action: AuditAction.BillingSubscriptionChanged,
    resource: { type: 'subscription', id: plan.subscriptionId },
    metadata: { change: 'resumed' },
  });
  await resync(deps, plan.subscriptionId, 'plan_resume');
}

/** Drop the change waiting for the end of the period. */
export async function cancelScheduledChange(
  deps: PlanChangeDeps,
  input: { organisationId: string; userId: string },
): Promise<void> {
  const plan = await currentPlan(deps.db, input.organisationId);
  if (!plan?.scheduleId)
    throw new ConflictError('There is no scheduled change', { reason: 'no_scheduled_change' });
  await deps.gateway.releaseSchedule(
    plan.scheduleId,
    stripeKey(input.organisationId, 'plan_release'),
  );
  deps.audit({
    actorUserId: input.userId,
    organisationId: input.organisationId,
    action: AuditAction.BillingSubscriptionChanged,
    resource: { type: 'subscription', id: plan.subscriptionId },
    metadata: { change: 'scheduled_change_cancelled' },
  });
  await resync(deps, plan.subscriptionId, 'plan_schedule_released');
}

/** Store what Stripe now says (never fails the request: the webhook syncs it anyway). */
async function resync(deps: PlanChangeDeps, subscriptionId: string, cause: string) {
  try {
    const state: SubscriptionState | null = await deps.gateway.retrieveSubscription(subscriptionId);
    if (state) await syncSubscription(deps, state, cause);
  } catch (err) {
    deps.logger.warn({ err, subscriptionId, cause }, 'plan change synced later by the webhook');
  }
}
