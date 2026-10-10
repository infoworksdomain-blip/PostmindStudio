import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AuditAction } from '../../audit-sink';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
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
  currentPeriodStart: Date | null;
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
 * A Stripe Idempotency-Key; the same shape as service.ts idempotencyKey: studio-<intent>-<digest>.
 * With `parts` (26.3, plan changes) it is derived from the change itself, so a double submit
 * (two tabs, a retry without the route's Idempotency-Key) is ONE Stripe write: Stripe answers the
 * second with the first's result for 24 hours. Without `parts` it is fresh per call (cancel and
 * resume may be repeated on purpose).
 */
function stripeKey(
  organisationId: string,
  intent: string,
  parts: ReadonlyArray<string | number> = [randomBytes(12).toString('hex')],
): string {
  const digest = createHash('sha256')
    .update([organisationId, intent, ...parts].join('|'))
    .digest('hex');
  return `studio-${intent}-${digest.slice(0, 40)}`;
}

/**
 * The time part of a change's key when there is no proration time: the minute, so a double
 * submit collapses while the same change made again on purpose later still reaches Stripe.
 * shortcut: a deliberate repeat within the same minute (schedule, keep, schedule) is answered
 * from Stripe's cache; put the live schedule id in the key if that ever matters.
 */
const KEY_BUCKET_SEC = 60;

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
    currentPeriodStart: sub.currentPeriodStart,
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
  // 26.3: the plan as Stripe has it NOW (a concurrent request may have changed it since our row
  // was stored), so a change that is no longer needed is refused before any write.
  const livePlan = live.lookupKey
    ? planOfRow({ lookupKey: live.lookupKey, quantity: live.quantity })
    : null;
  return {
    plan: {
      ...plan,
      ...(livePlan && {
        plan: livePlan.plan,
        interval: livePlan.interval,
        legacy: livePlan.legacy,
      }),
      itemId: live.itemId,
      scheduleId: live.scheduleId,
      currentPeriodStart: live.currentPeriodStart ?? plan.currentPeriodStart,
    },
    live,
  };
}

/** Customers never see Stripe lookup keys (26.3); the key is logged for the operator. */
const PLAN_UNAVAILABLE = "This plan isn't available right now. Please try again later.";

async function planPrice(deps: Pick<PlanChangeDeps, 'gateway' | 'logger'>, next: PlanChoice) {
  const lookupKey = planLookupKey(next.plan, next.interval);
  const [price] = (await deps.gateway.listPrices([lookupKey])).filter((p) => p.active);
  if (!price || price.unitAmountPence === null) {
    deps.logger.warn({ lookupKey }, 'no active Stripe price for a plan lookup key');
    throw new NotFoundError(PLAN_UNAVAILABLE);
  }
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
  const price = await planPrice(deps, next);
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
/** Clock skew allowed between the preview's server and this one. */
const PRORATION_DATE_MAX_SKEW_SEC = 60;

/**
 * 26.3 (security review): the client echoes the previewed proration time; it is used only when
 * it is not in the future (beyond a minute of skew), at most 30 minutes old and inside the
 * current period. Anything else is REFUSED (400) rather than silently replaced by now: a future
 * time would prorate an upgrade as if the period were almost over, and a silent substitute would
 * charge a different amount from the one the customer confirmed. Absent = now.
 */
export function confirmedProrationDate(
  given: number | null | undefined,
  nowSec: number,
  periodStart: Date | null,
): number {
  if (given === null || given === undefined) return nowSec;
  const startSec = periodStart ? Math.floor(periodStart.getTime() / 1000) : null;
  if (
    given > nowSec + PRORATION_DATE_MAX_SKEW_SEC ||
    nowSec - given > PRORATION_DATE_MAX_AGE_SEC ||
    (startSec !== null && given < startSec)
  )
    throw new ValidationError('This price has expired. Review the change and confirm it again.', {
      reason: 'proration_date_out_of_range',
    });
  return given;
}

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
  const nowSec = Math.floor(deps.now() / 1000);
  const prorationDate =
    timing === 'now' && plan.status !== 'trialing'
      ? confirmedProrationDate(input.prorationDate, nowSec, plan.currentPeriodStart)
      : null;
  const price = await planPrice(deps, next);
  // The same change -> the same Stripe key (see stripeKey).
  const changeKey = (intent: string) =>
    stripeKey(organisationId, intent, [
      plan.subscriptionId,
      price.id,
      timing,
      prorationDate ?? Math.floor(nowSec / KEY_BUCKET_SEC),
    ]);
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
      changeKey('plan_schedule'),
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
        stripeKey(organisationId, 'plan_release', [plan.scheduleId]),
      );
    const state = await deps.gateway.changePlanNow(
      { ...change, prorationDate },
      changeKey('plan_now'),
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
