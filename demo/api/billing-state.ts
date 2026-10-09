// The demo organisation's billing state (Phase 18 §P.3, Phase 26.1 tiered plans), switchable
// from the demo bar and by a `?demoPlan=<state>` query on any tour link. It drives GET /me (plan
// and banner), GET /billing ("Your plan"), GET /usage (the allowance and the tier the lock badges
// read), the members seat limit, the Your-plan changes (preview, change, cancel, resume, keep the
// current plan) and a request gate that answers like the real API: 402 plan_required /
// billing_required (access gate), 403 plan_tier (feature gates) and 403 quota_exceeded (the plan's
// video allowance, video-pack credits first). The choice is kept in a cookie, like the demo's
// language; purchases made in the simulated checkout move the state on, as Stripe's webhooks would.
//
// 26.1: customers buy one of three plans, Starter / Growth / Pro (plans.ts), weekly, monthly or
// yearly. Every plan posts to all six platforms (no channel limit) and is the internal tier
// STANDARD. Generation cost is never part of a customer-facing answer here.
// 23.3: carousels, slideshows, wall of text and hook + demo use ¼ of a video (allowance and packs).
import { quartersToVideos, VIDEO_QUARTERS } from '@/lib/studio/billing/allowance-units';
import {
  CATALOGUE_VERSION,
  ENTERPRISE_LIST_PRICE_PENCE,
  PLAN_CATALOGUE,
  TOP_UP_PACKS,
  TRIAL,
  minTierFor,
  minTierForImageLibrary,
  tierAtLeast,
} from '@/lib/studio/billing/catalogue';
import {
  ALLOWANCE_WINDOW,
  STUDIO_PLANS,
  allowancePerWindow,
  isPlanId,
  isPlanInterval,
  planChangeTiming,
  planCostCapsPence,
  planLookupKey,
  type PlanChoice,
  type PlanId,
  type PlanInterval,
} from '@/lib/studio/billing/plans';
import type {
  BillingResponse,
  PlanChangeOutcome,
  PlanChangePreviewView,
  PlanTier,
  PlanView,
} from '@/components/studio/billing/types';
import { demoAccessDecision, type DemoAccess } from './billing-access';
import { DemoHttpError, setRequestGate } from './registry';

export const BILLING_STATES = [
  'trial',
  'active_monthly',
  'allowance_used',
  'active_weekly',
  'active_yearly',
  'past_due',
  'read_only',
  'no_plan',
  'enterprise',
  'cancelled',
] as const;

export type BillingStateId = (typeof BILLING_STATES)[number];

export const DEFAULT_BILLING_STATE: BillingStateId = 'active_monthly';

/** Query parameter on a tour link that switches the state before the screen loads. */
export const DEMO_PLAN_PARAM = 'demoPlan';

const COOKIE = 'studio.demoPlan';
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const DAY = 86_400_000;

interface StateInfo {
  label: string;
  /** The internal tier (staff views, lock badges): STANDARD for every plan. */
  tier: PlanTier;
  access: DemoAccess;
  source: 'stripe' | 'trial' | 'admin' | 'none';
  /** Stripe subscription status, or null for no subscription. */
  status: string | null;
  /** The plan and interval (null: no plan, or a staff-set Enterprise plan). */
  plan: PlanChoice | null;
  /** Sample videos already made in the current allowance window. */
  used: number;
  note: string;
}

const GROWTH_MONTHLY: PlanChoice = { plan: 'growth', interval: 'month' };

/** The trial length the demo pricing shows (STUDIO_TRIAL_DAYS 7, test-fixtures.ts). */
export const DEMO_TRIAL_DAYS = 7;
/** Days left on the sample trial when the state is switched to. */
const SAMPLE_TRIAL_DAYS_LEFT = 4;

export const BILLING_STATE_INFO: Record<BillingStateId, StateInfo> = {
  trial: {
    label: 'Trial (Growth)',
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    status: 'trialing',
    plan: GROWTH_MONTHLY,
    used: 1,
    note: '7-day trial, 4 days left: 1 of the 2 trial videos made, trial banner.',
  },
  active_monthly: {
    label: 'Active: Growth, monthly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: GROWTH_MONTHLY,
    used: 15.5,
    note: 'The default: 15.5 of 20 videos this month (two carousels counted ¼ each), 3 seats; every connected platform publishes.',
  },
  allowance_used: {
    label: 'Allowance used up',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { plan: 'starter', interval: 'month' },
    used: 8,
    note: 'Starter, all 8 videos this month made: generating offers a video pack or a bigger plan.',
  },
  active_weekly: {
    label: 'Active: Starter, weekly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { plan: 'starter', interval: 'week' },
    used: 1,
    note: '2 videos a week, 1 made this week; the allowance resets on Monday.',
  },
  active_yearly: {
    label: 'Active: Pro, yearly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { plan: 'pro', interval: 'year' },
    used: 20,
    note: 'Paid upfront: 45 videos released each month, 3 businesses and 10 seats.',
  },
  past_due: {
    label: 'Past due (grace)',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'past_due',
    plan: GROWTH_MONTHLY,
    used: 16,
    note: 'A payment failed: full access for 4 more days, with a banner and the grace date.',
  },
  read_only: {
    label: 'Read-only (unpaid)',
    tier: 'STANDARD',
    access: 'read_only',
    source: 'stripe',
    status: 'unpaid',
    plan: GROWTH_MONTHLY,
    used: 16,
    note: 'Grace ended: changes answer 402 billing_required; export and downloads still work.',
  },
  no_plan: {
    label: 'No plan',
    tier: 'BASIC',
    access: 'none',
    source: 'none',
    status: null,
    plan: null,
    used: 0,
    note: 'Signed up, never subscribed: set up freely, but generate / publish / scan need a plan.',
  },
  enterprise: {
    label: 'Enterprise',
    tier: 'ENTERPRISE',
    access: 'full',
    source: 'admin',
    status: 'active',
    plan: null,
    used: 33,
    note: 'Staff-set plan with custom limits (40 seats, unlimited videos); no self-serve changes.',
  },
  cancelled: {
    label: 'Cancelled (read-only)',
    // An ended subscription has no plan (entitlements.ts: canceled → BASIC, source none).
    tier: 'BASIC',
    access: 'read_only',
    source: 'none',
    status: 'canceled',
    plan: null,
    used: 0,
    note: 'The paid period ended after cancelling: read-only, data kept for 90 days.',
  },
};

export function isBillingStateId(value: unknown): value is BillingStateId {
  return typeof value === 'string' && (BILLING_STATES as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ store

function readCookie(): BillingStateId | null {
  if (typeof document === 'undefined') return null;
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const value = raw ? decodeURIComponent(raw) : null;
  return isBillingStateId(value) ? value : null;
}

function writeCookie(id: BillingStateId): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax`;
}

let current: BillingStateId = readCookie() ?? DEFAULT_BILLING_STATE;
/** A plan chosen in the demo checkout or changed on Your plan (else the state's own plan). */
let planOverride: PlanChoice | null = null;
/** A downgrade waiting for the end of the period (Your plan shows it with "Keep my plan"). */
let pending: { plan: PlanId; interval: PlanInterval; effectiveAt: string } | null = null;
let cancelAtPeriodEnd = false;
/** An interval upgrade starts a new billing period today (Stripe resets the anchor). */
let periodStartedAt: number | null = null;
/** Started in the demo checkout just now: one invoice, dated today (none earlier). */
let freshSubscription = false;
/** Videos generated in this page load (on top of each state's sample usage; 23.3: ¼ steps). */
let generatedShort = 0;
const credits = { short: 0, long: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Usage or credits moved without a plan change (a generation, a credit used). */
const usageListeners = new Set<() => void>();

export function subscribeUsage(listener: () => void): () => void {
  usageListeners.add(listener);
  return () => {
    usageListeners.delete(listener);
  };
}

function emitUsage(): void {
  // After the request that caused it has answered, so its screen updates first.
  setTimeout(() => {
    for (const listener of [...usageListeners]) listener();
  }, 0);
}

export function getBillingState(): BillingStateId {
  return current;
}

export function subscribeBillingState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Switch the demo organisation's billing state (persisted like the demo's locale). */
export function setBillingState(id: BillingStateId): void {
  const changed = id !== current;
  current = id;
  planOverride = null;
  pending = null;
  cancelAtPeriodEnd = false;
  periodStartedAt = null;
  freshSubscription = false;
  generatedShort = 0;
  trialDaysLeft = SAMPLE_TRIAL_DAYS_LEFT;
  writeCookie(id);
  if (changed) emit();
}

const info = () => BILLING_STATE_INFO[current];

/** The organisation's tier (what GET /usage reports and the lock badges compare against). */
export function currentTier(): PlanTier {
  return info().tier;
}

/** The plan in force (plan and interval), or null. */
export function currentPlan(): PlanChoice | null {
  return planOverride ?? info().plan;
}

// ------------------------------------------------------------------ prices

let priceLookup: (lookupKey: string) => number = () => 0;

/** p18-billing.ts supplies the reference prices (it owns the pricing view). */
export function setPriceLookup(lookup: (lookupKey: string) => number): void {
  priceLookup = lookup;
}

/** What a plan costs per billing period, in pence (excl. VAT). */
export function planPrice(choice: PlanChoice): number {
  return priceLookup(planLookupKey(choice.plan, choice.interval));
}

// ------------------------------------------------------------------ derived views

const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const ENTERPRISE_LIMITS = { seats: 40, businesses: 25, storageGb: 2_000 } as const;

export function limits(): { seats: number | null; businesses: number | null; storageGb: number } {
  if (current === 'enterprise') return { ...ENTERPRISE_LIMITS };
  const tier = PLAN_CATALOGUE[info().tier];
  // 26.1: seats and businesses come from the plan (entitlements.ts limitsFor), storage the tier.
  const plan = currentPlan();
  const own = plan ? STUDIO_PLANS[plan.plan] : tier;
  return { seats: own.seats, businesses: own.businesses, storageGb: tier.storageGb ?? 0 };
}

export function graceUntil(): string | null {
  return current === 'past_due' ? at(4) : null;
}

/** 4 days left when switched to; a trial just started in the demo checkout has all 7. */
let trialDaysLeft = SAMPLE_TRIAL_DAYS_LEFT;
const trialEnd = () => at(trialDaysLeft - 1 / 24);

const PERIOD_DAYS: Readonly<Record<PlanInterval, number>> = { week: 7, month: 30, year: 365 };
/** Days left in the current paid period when a state is switched to. */
const DAYS_LEFT: Readonly<Record<PlanInterval, number>> = { week: 4, month: 18, year: 200 };

/** When the current billing period ends (ms). */
function periodEndMs(): number {
  if (current === 'trial') return Date.parse(trialEnd());
  if (current === 'cancelled') return Date.now() - 2 * DAY;
  const interval = currentPlan()?.interval ?? 'month';
  if (periodStartedAt !== null) return periodStartedAt + PERIOD_DAYS[interval] * DAY;
  return Date.now() + DAYS_LEFT[interval] * DAY;
}

/** The share of the current period still to run (0–1), for the proration preview. */
function periodRemaining(): number {
  const interval = currentPlan()?.interval ?? 'month';
  const left = Math.max(0, periodEndMs() - Date.now());
  return Math.min(1, left / (PERIOD_DAYS[interval] * DAY));
}

/** The window the allowance is counted in: an ISO week for a weekly plan, else the month. */
export function allowancePeriod(): 'week' | 'month' {
  const plan = currentPlan();
  return plan && current !== 'trial' ? ALLOWANCE_WINDOW[plan.interval] : 'month';
}

/** The video allowance and use in the current window: `limit` null = unlimited. */
export function videoQuota(): {
  short: { used: number; limit: number | null };
  long: { used: number; limit: number | null };
} {
  if (current === 'trial')
    return {
      short: { used: info().used + generatedShort, limit: TRIAL.shortVideos },
      long: { used: 0, limit: 0 },
    };
  if (current === 'enterprise')
    return {
      short: { used: info().used + generatedShort, limit: null },
      long: { used: 0, limit: null },
    };
  const plan = currentPlan();
  if (!plan) {
    // No plan: nothing made yet (generating needs a plan; the access gate answers first).
    const basic = PLAN_CATALOGUE.BASIC;
    return {
      short: { used: 0, limit: basic.shortVideosPerMonth },
      long: { used: 0, limit: basic.longVideosPerMonth },
    };
  }
  const limit = allowancePerWindow(plan.plan, plan.interval);
  // Long videos are not part of the plan (allowance 0, hidden in the customer UI).
  return {
    short: { used: Math.min(info().used, limit) + generatedShort, limit },
    long: { used: 0, limit: 0 },
  };
}

/**
 * Internal cost cap and spend this month for the staff-only figures (month plan internals, admin).
 * Never part of a customer-facing answer.
 */
export function internalCostThisMonth(): { capPence: number | null; spentPence: number } {
  const plan = currentPlan();
  const capPence =
    current === 'trial'
      ? TRIAL.totalCostCapPence
      : current === 'enterprise'
        ? PLAN_CATALOGUE.ENTERPRISE.monthlyCostCapPence
        : plan
          ? planCostCapsPence(plan.plan, plan.interval).monthlyPence
          : 0;
  const spentPence = current === 'no_plan' ? 0 : current === 'trial' ? 640 : 4_500;
  return { capPence, spentPence };
}

function subscription(): BillingResponse['billing']['subscription'] {
  const { status } = info();
  if (!status) return null;
  const plan = currentPlan();
  return {
    status,
    lookupKey: plan ? planLookupKey(plan.plan, plan.interval) : null,
    interval: plan?.interval ?? 'month',
    quantity: 1,
    currentPeriodEnd: new Date(periodEndMs()).toISOString(),
    cancelAtPeriodEnd: (status === 'active' || status === 'trialing') && cancelAtPeriodEnd,
    trialEnd: current === 'trial' ? trialEnd() : null,
  };
}

function planView(): PlanView | null {
  const plan = currentPlan();
  if (!plan) return null;
  return {
    id: plan.plan,
    interval: plan.interval,
    source: 'stripe',
    legacy: false,
    pricePerPeriodPence: planPrice(plan),
    currency: 'gbp',
    pending,
    paymentPending: false,
  };
}

/** GET /billing (src/lib/studio/billing/overview.ts shape: no cost or budget figures). */
export function billingOverview(seatsUsed: number): BillingResponse['billing'] {
  const { tier, access, source, status } = info();
  const l = limits();
  return {
    catalogueVersion: CATALOGUE_VERSION,
    entitlements: {
      tier,
      access,
      source,
      graceUntil: graceUntil(),
      limits: { seats: l.seats, businesses: l.businesses, storageGb: l.storageGb },
      custom:
        current === 'enterprise'
          ? { seats: ENTERPRISE_LIMITS.seats, businesses: ENTERPRISE_LIMITS.businesses }
          : null,
      trial:
        current === 'trial'
          ? {
              startedAt: at(trialDaysLeft - DEMO_TRIAL_DAYS),
              endsAt: trialEnd(),
              shortVideos: TRIAL.shortVideos,
              longVideos: TRIAL.longVideos,
              dailyCostCapPence: TRIAL.dailyCostCapPence,
              totalCostCapPence: TRIAL.totalCostCapPence,
            }
          : null,
      subscriptionStatus: status,
    },
    subscription: subscription(),
    plan: planView(),
    hasBillingAccount: current !== 'no_plan',
    trialEligible: current === 'no_plan',
    credits: { ...credits },
    usage: {
      seats: { used: seatsUsed, limit: l.seats },
      businesses: { used: 1, limit: l.businesses },
      storage: {
        usedBytes: String(12 * 1024 ** 3),
        limitGb: l.storageGb,
        percent: Math.round((12 / l.storageGb) * 100),
      },
    },
    canManage: true,
    checkoutEnabled: true,
  };
}

/** GET /me: the plan line (Starter / Growth / Pro and the interval) and the banner. */
export function meBilling(): {
  plan: { tier: string; access: string; source: string; studioPlan?: string; interval?: string };
  banner:
    | { kind: 'trial'; endsAt: string }
    | { kind: 'past_due'; graceUntil: string | null }
    | { kind: 'read_only' }
    | { kind: 'no_plan' }
    | null;
} {
  const { tier, access, source } = info();
  const plan = currentPlan();
  const banner =
    current === 'trial'
      ? { kind: 'trial' as const, endsAt: trialEnd() }
      : current === 'past_due'
        ? { kind: 'past_due' as const, graceUntil: graceUntil() }
        : current === 'read_only' || current === 'cancelled'
          ? { kind: 'read_only' as const }
          : current === 'no_plan'
            ? { kind: 'no_plan' as const }
            : null;
  return {
    plan: {
      tier,
      access,
      source,
      ...(plan && { studioPlan: plan.plan, interval: plan.interval }),
    },
    banner,
  };
}

/**
 * GET /billing/invoices: three invoices at the plan's price (the latest open while unpaid); a
 * subscription started in the demo checkout just now has one, dated today (£0 for a trial).
 */
export function invoices(): Array<Record<string, unknown>> {
  if (current === 'no_plan') return [];
  // A cancelled organisation's invoices are from the Growth plan it had.
  const plan = currentPlan() ?? (current === 'cancelled' ? GROWTH_MONTHLY : null);
  const price = current === 'enterprise' ? ENTERPRISE_LIST_PRICE_PENCE : plan ? planPrice(plan) : 0;
  const amount = freshSubscription && current === 'trial' ? 0 : price;
  const failing = current === 'past_due' || current === 'read_only';
  const step = PERIOD_DAYS[plan?.interval ?? 'month'];
  return (freshSubscription ? [0] : [0, 1, 2]).map((n) => ({
    id: `in_demo_${n}`,
    number: `LSD-00${12 - n}`,
    status: failing && n === 0 ? 'open' : 'paid',
    amountDuePence: amount,
    currency: 'gbp',
    createdAt: freshSubscription ? at(0) : at(-(n * step + 12)),
    hostedInvoiceUrl: null,
    invoicePdfUrl: null,
  }));
}

// ------------------------------------------------------------------ Your plan (26.1)

const CHANGEABLE = new Set(['active', 'trialing']);

function conflict(message: string, details: Record<string, unknown>): DemoHttpError {
  return new DemoHttpError(409, 'conflict', message, details);
}

function changeablePlan(): PlanChoice {
  const plan = currentPlan();
  if (!plan)
    throw new DemoHttpError(
      404,
      'not_found',
      'This organisation has no plan to change; choose one first',
    );
  const status = info().status ?? '';
  if (!CHANGEABLE.has(status))
    throw conflict('Fix the payment first, then change the plan', {
      reason: 'subscription_not_changeable',
      subscriptionStatus: status,
    });
  if (cancelAtPeriodEnd)
    throw conflict('Resume the plan before changing it', { reason: 'cancelling' });
  return plan;
}

function timingFor(plan: PlanChoice, next: PlanChoice) {
  const timing = planChangeTiming(plan, next);
  // A trial is charged nothing until it ends: every change applies at once.
  return timing === 'period_end' && current === 'trial' ? 'now' : timing;
}

/** GET /billing/plan/preview: the new price, when it applies and what is due now. */
export function previewPlanChange(next: PlanChoice): PlanChangePreviewView {
  const plan = changeablePlan();
  const timing = timingFor(plan, next);
  const base = {
    timing,
    current: { ...plan },
    next,
    nextPricePence: planPrice(next),
    currency: 'gbp',
  };
  if (timing === 'none')
    return { ...base, effectiveAt: null, dueNowPence: null, prorationDate: null };
  if (timing === 'period_end')
    return {
      ...base,
      effectiveAt: new Date(periodEndMs()).toISOString(),
      dueNowPence: null,
      prorationDate: null,
    };
  const now = new Date().toISOString();
  if (current === 'trial')
    return { ...base, effectiveAt: now, dueNowPence: 0, prorationDate: null };
  // Stripe-like proration: the unused part of the current period is credited.
  const left = periodRemaining();
  const currentPrice = planPrice(plan);
  const dueNowPence =
    next.interval === plan.interval
      ? Math.round(left * (base.nextPricePence - currentPrice))
      : base.nextPricePence - Math.round(left * currentPrice);
  return {
    ...base,
    effectiveAt: now,
    dueNowPence: Math.max(0, dueNowPence),
    prorationDate: Math.floor(Date.now() / 1000),
  };
}

/** POST /billing/plan: upgrades now (prorated), downgrades at the end of the period. */
export function changePlan(next: PlanChoice): PlanChangeOutcome {
  const plan = changeablePlan();
  const timing = timingFor(plan, next);
  if (timing === 'none') throw conflict('That is already your plan', { reason: 'same' });
  if (timing === 'period_end') {
    const effectiveAt = new Date(periodEndMs()).toISOString();
    pending = { plan: next.plan, interval: next.interval, effectiveAt };
    emit();
    return { status: 'scheduled', timing, effectiveAt };
  }
  if (next.interval !== plan.interval && current !== 'trial') periodStartedAt = Date.now();
  planOverride = { ...next };
  pending = null;
  emit();
  return { status: 'applied', timing: 'now' };
}

/** POST /billing/plan/cancel: the plan ends at the end of the period (a scheduled change goes). */
export function cancelPlan(): { endsAt: string | null } {
  const status = info().status ?? '';
  if (!currentPlan() || (!CHANGEABLE.has(status) && status !== 'past_due'))
    throw new DemoHttpError(404, 'not_found', 'This organisation has no plan to cancel');
  cancelAtPeriodEnd = true;
  pending = null;
  emit();
  return { endsAt: new Date(periodEndMs()).toISOString() };
}

/** POST /billing/plan/resume: keep a plan that was set to end. */
export function resumePlan(): void {
  if (!cancelAtPeriodEnd)
    throw conflict('This plan is not set to end', { reason: 'not_cancelling' });
  cancelAtPeriodEnd = false;
  emit();
}

/** DELETE /billing/plan/scheduled: keep the current plan, drop the change at period end. */
export function keepCurrentPlan(): void {
  if (!pending) throw conflict('There is no scheduled change', { reason: 'no_scheduled_change' });
  pending = null;
  emit();
}

export function isCancelling(): boolean {
  return cancelAtPeriodEnd;
}

// ------------------------------------------------------------------ simulated checkout & portal

export type DemoCheckoutIntent =
  | { kind: 'plan'; plan: PlanId; interval: PlanInterval }
  | { kind: 'topup'; lookupKey: string }
  | { kind: 'portal' };

/** The hash URL POST /billing/checkout and /billing/portal answer (never Stripe). */
export function checkoutHref(intent: DemoCheckoutIntent): string {
  const q = new URLSearchParams({ kind: intent.kind });
  if (intent.kind === 'plan') {
    q.set('plan', intent.plan);
    q.set('interval', intent.interval);
  }
  if (intent.kind === 'topup') q.set('lookupKey', intent.lookupKey);
  return `#/demo-checkout?${q.toString()}`;
}

export function parseCheckoutIntent(search: URLSearchParams): DemoCheckoutIntent | null {
  const kind = search.get('kind');
  if (kind === 'portal') return { kind };
  if (kind === 'topup') {
    const lookupKey = search.get('lookupKey') ?? '';
    return TOP_UP_PACKS.some((p) => p.lookupKey === lookupKey) ? { kind, lookupKey } : null;
  }
  if (kind === 'plan') {
    const plan = search.get('plan');
    const interval = search.get('interval');
    if (isPlanId(plan) && isPlanInterval(interval)) return { kind, plan, interval };
  }
  return null;
}

/** Whether completing a plan checkout starts the one-per-organisation trial. */
export function startsTrial(): boolean {
  return current === 'no_plan';
}

/** "Complete demo payment": what checkout.session.completed would do. */
export function completeCheckout(intent: DemoCheckoutIntent): 'checkout' | 'topup' {
  if (intent.kind === 'topup') {
    const pack = TOP_UP_PACKS.find((p) => p.lookupKey === intent.lookupKey);
    if (pack) credits[pack.kind] += pack.quantity;
    emit();
    return 'topup';
  }
  if (intent.kind === 'plan') {
    const trial = startsTrial();
    setBillingState(trial ? 'trial' : 'active_monthly');
    planOverride = { plan: intent.plan, interval: intent.interval };
    if (trial) trialDaysLeft = DEMO_TRIAL_DAYS;
    freshSubscription = true;
    emit();
  }
  return 'checkout';
}

/** The simulated Customer Portal (payment method and invoices only, as in 21.5). */
export function portalUpdatePayment(): void {
  const keep = currentPlan();
  const next: BillingStateId =
    current === 'past_due' || current === 'read_only' || current === 'cancelled'
      ? 'active_monthly'
      : current;
  setBillingState(next);
  if (keep && next !== current) planOverride = { ...keep };
  emit();
}

// ------------------------------------------------------------------ request gate

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function requireTier(required: PlanTier, feature: string): void {
  if (tierAtLeast(info().tier, required)) return;
  throw new DemoHttpError(403, 'plan_tier', 'This feature is not included in your plan', {
    requiredTier: required,
    feature,
  });
}

function featureGate(method: string, path: string, body: unknown): void {
  if (method !== 'POST') return;
  if (path === '/voice-profiles') requireTier(minTierFor('voiceClone'), 'voiceClone');
  if (path === '/image-library/generate')
    requireTier(minTierForImageLibrary('ai_generation'), 'imageGeneration');
  const b = obj(body);
  if (
    path === '/projects' &&
    b.sourceType === 'LIBRARY_REFERENCE' &&
    b.referenceMode === 'TEMPLATE'
  )
    requireTier(minTierFor('libraryTemplate'), 'libraryTemplate');
}

function quotaGate(method: string, path: string): void {
  if (method !== 'POST' || !/^\/projects\/[^/]+\/generate$/.test(path)) return;
  const { short } = videoQuota();
  // 23.3: a quick post uses ¼ of a video (quarters are exact in floating point).
  const videos = quartersToVideos(projectQuarters(path.split('/')[2] ?? ''));
  if (short.limit !== null && short.used + videos > short.limit) {
    if (credits.short >= videos) {
      credits.short -= videos;
      emitUsage();
      return;
    }
    const period = allowancePeriod();
    throw new DemoHttpError(
      403,
      'quota_exceeded',
      `Your plan includes ${short.limit} videos a ${period} and ${short.used} have been generated. Upgrade your plan or buy a video pack for more.`,
      { resource: 'short_videos', used: short.used, limit: short.limit, studioPlan: true },
    );
  }
  generatedShort += videos;
  emitUsage();
}

/** 23.3: quarters of a video a demo project uses (p18-billing.ts looks the project up). */
let projectQuarters: (projectId: string) => number = () => VIDEO_QUARTERS;

export function setProjectQuartersLookup(lookup: (projectId: string) => number): void {
  projectQuarters = lookup;
}

setRequestGate(({ method, path, body }) => {
  const decision = demoAccessDecision(info().access, method, path);
  if (!decision.allowed) {
    const details = { access: info().access, planTier: info().tier };
    if (decision.code === 'plan_required')
      throw new DemoHttpError(
        402,
        'plan_required',
        'Choose a plan to generate, publish or scan',
        details,
      );
    throw new DemoHttpError(
      402,
      'billing_required',
      'Your subscription needs attention: update the payment method to make changes',
      details,
    );
  }
  featureGate(method, path, body);
  quotaGate(method, path);
});
