// The demo organisation's billing state (Phase 18 §P.3, Phase 21.5 per-channel plan), switchable
// from the demo bar and by a `?demoPlan=<state>` query on any tour link. It drives GET /me (plan,
// channels + banner), GET /billing ("Your plan"), GET /usage (the allowance and the tier the lock
// badges read), the members seat limit, the Your-plan changes (preview, change, cancel, resume,
// keep the current plan) and a request gate that answers like the real API: 402 plan_required /
// billing_required (access gate), 403 plan_tier (feature gates), 403 quota_exceeded (the plan's
// video allowance, video-pack credits first) and 403 channel_limit (publishing to a platform past
// the paid channels). The choice is kept in a cookie, like the demo's language; purchases made in
// the simulated checkout move the state on, as Stripe's webhooks would.
//
// 21.5: customers buy ONE plan, £29 per channel a month with 8 videos per channel (weekly: 2 per
// channel a week; yearly: 96 a year released as 8 a month). Every channel subscription is the
// internal tier STANDARD. Generation cost is never part of a customer-facing answer here.
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
  CHANNEL_LOOKUP_KEYS,
  allowancePerWindow,
  channelCostCapsPence,
  isChannelInterval,
  isValidChannelCount,
  planChangeTiming,
  type ChannelInterval,
  type ChannelPlanChoice,
} from '@/lib/studio/billing/channel-plan';
import {
  channelUsage,
  type ChannelUsage,
  type ConnectionFact,
} from '@/lib/studio/billing/channels';
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
  /** The internal tier (staff views, lock badges): STANDARD for every channel plan. */
  tier: PlanTier;
  access: DemoAccess;
  source: 'stripe' | 'trial' | 'admin' | 'none';
  /** Stripe subscription status, or null for no subscription. */
  status: string | null;
  /** The per-channel plan (null: no plan, or a staff-set Enterprise plan). */
  plan: ChannelPlanChoice | null;
  /** Sample videos already made in the current allowance window. */
  used: number;
  note: string;
}

const THREE_MONTHLY: ChannelPlanChoice = { channels: 3, interval: 'month' };

export const BILLING_STATE_INFO: Record<BillingStateId, StateInfo> = {
  trial: {
    label: 'Trial (3 channels)',
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    status: 'trialing',
    plan: THREE_MONTHLY,
    used: 3,
    note: '14-day trial, 9 days left: 3 of the 5 trial videos made, trial banner.',
  },
  active_monthly: {
    label: 'Active: 3 channels, monthly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: THREE_MONTHLY,
    used: 19.5,
    note: 'The default: 19.5 of 24 videos this month (two carousels counted ¼ each). Six platforms connected, the first three publish.',
  },
  allowance_used: {
    label: 'Allowance used up',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { channels: 1, interval: 'month' },
    used: 8,
    note: '1 channel, all 8 videos this month made: generating offers a video pack or a channel.',
  },
  active_weekly: {
    label: 'Active: 2 channels, weekly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { channels: 2, interval: 'week' },
    used: 1,
    note: '4 videos a week (2 per channel), 1 made this week; the allowance resets on Monday.',
  },
  active_yearly: {
    label: 'Active: 6 channels, yearly',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    plan: { channels: 6, interval: 'year' },
    used: 20,
    note: 'Paid upfront: 48 videos released each month (8 per channel); every platform publishes.',
  },
  past_due: {
    label: 'Past due (grace)',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'past_due',
    plan: THREE_MONTHLY,
    used: 20,
    note: 'A payment failed: full access for 4 more days, with a banner and the grace date.',
  },
  read_only: {
    label: 'Read-only (unpaid)',
    tier: 'STANDARD',
    access: 'read_only',
    source: 'stripe',
    status: 'unpaid',
    plan: THREE_MONTHLY,
    used: 20,
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
    // An ended subscription has no channel plan (entitlements.ts: canceled → BASIC, source none).
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
let planOverride: ChannelPlanChoice | null = null;
/** A downgrade waiting for the end of the period (Your plan shows it with "Keep my plan"). */
let pending: { channels: number; interval: ChannelInterval; effectiveAt: string } | null = null;
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
  trialDaysLeft = 9;
  writeCookie(id);
  if (changed) emit();
}

const info = () => BILLING_STATE_INFO[current];

/** The organisation's tier (what GET /usage reports and the lock badges compare against). */
export function currentTier(): PlanTier {
  return info().tier;
}

/** The per-channel plan in force (channels and interval), or null. */
export function currentPlan(): ChannelPlanChoice | null {
  return planOverride ?? info().plan;
}

// ------------------------------------------------------------------ connections & prices

let connectionLookup: () => ConnectionFact[] = () => [];

/** p18-billing.ts supplies the connected platforms (it can import the connections handler). */
export function setConnectionLookup(lookup: () => ConnectionFact[]): void {
  connectionLookup = lookup;
}

/** Connected platforms against the paid channels (null without a channel plan). */
export function channelsInUse(): ChannelUsage | null {
  const plan = currentPlan();
  return plan ? channelUsage(connectionLookup(), plan.channels) : null;
}

let priceLookup: (lookupKey: string) => number = () => 0;

/** p18-billing.ts supplies the reference prices (it owns the pricing view). */
export function setPriceLookup(lookup: (lookupKey: string) => number): void {
  priceLookup = lookup;
}

/** The per-channel price of an interval, in pence (excl. VAT). */
export function unitPrice(interval: ChannelInterval): number {
  return priceLookup(CHANNEL_LOOKUP_KEYS[interval]);
}

// ------------------------------------------------------------------ derived views

const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const ENTERPRISE_LIMITS = { seats: 40, businesses: 25, storageGb: 2_000 } as const;

export function limits(): { seats: number | null; businesses: number | null; storageGb: number } {
  if (current === 'enterprise') return { ...ENTERPRISE_LIMITS };
  const plan = PLAN_CATALOGUE[info().tier];
  return { seats: plan.seats, businesses: plan.businesses, storageGb: plan.storageGb ?? 0 };
}

export function graceUntil(): string | null {
  return current === 'past_due' ? at(4) : null;
}

/** 9 days left when switched to; a trial just started in the demo checkout has all 14. */
let trialDaysLeft = 9;
const trialEnd = () => at(trialDaysLeft - 1 / 24);

const PERIOD_DAYS: Readonly<Record<ChannelInterval, number>> = { week: 7, month: 30, year: 365 };
/** Days left in the current paid period when a state is switched to. */
const DAYS_LEFT: Readonly<Record<ChannelInterval, number>> = { week: 4, month: 18, year: 200 };

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
  const limit = allowancePerWindow(plan.channels, plan.interval);
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
          ? channelCostCapsPence(plan.channels, plan.interval).monthlyPence
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
    lookupKey: plan ? CHANNEL_LOOKUP_KEYS[plan.interval] : null,
    interval: plan?.interval ?? 'month',
    quantity: plan?.channels ?? 1,
    currentPeriodEnd: new Date(periodEndMs()).toISOString(),
    cancelAtPeriodEnd: (status === 'active' || status === 'trialing') && cancelAtPeriodEnd,
    trialEnd: current === 'trial' ? trialEnd() : null,
  };
}

function planView(): PlanView | null {
  const plan = currentPlan();
  if (!plan) return null;
  return {
    channels: plan.channels,
    interval: plan.interval,
    source: 'stripe',
    legacy: false,
    pricePerPeriodPence: unitPrice(plan.interval) * plan.channels,
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
              startedAt: at(-5),
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
    channels: channelsInUse(),
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

/** GET /me: the plan line (with channels), the connected-vs-paid channels and the banner. */
export function meBilling(): {
  plan: { tier: string; access: string; source: string; channels?: number; interval?: string };
  channels: { paid: number; connected: string[]; blocked: string[] } | null;
  banner:
    | { kind: 'trial'; endsAt: string }
    | { kind: 'past_due'; graceUntil: string | null }
    | { kind: 'read_only' }
    | { kind: 'no_plan' }
    | null;
} {
  const { tier, access, source } = info();
  const plan = currentPlan();
  const usage = channelsInUse();
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
      ...(plan && { channels: plan.channels, interval: plan.interval }),
    },
    channels: usage
      ? { paid: usage.paid, connected: usage.connected, blocked: usage.blocked }
      : null,
    banner,
  };
}

/**
 * GET /billing/invoices: three invoices at the plan's price (the latest open while unpaid); a
 * subscription started in the demo checkout just now has one, dated today (£0 for a trial).
 */
export function invoices(): Array<Record<string, unknown>> {
  if (current === 'no_plan') return [];
  // A cancelled organisation's invoices are from the 3-channel plan it had.
  const plan = currentPlan() ?? (current === 'cancelled' ? THREE_MONTHLY : null);
  const price =
    current === 'enterprise'
      ? ENTERPRISE_LIST_PRICE_PENCE
      : plan
        ? unitPrice(plan.interval) * plan.channels
        : 0;
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

// ------------------------------------------------------------------ Your plan (21.5)

const CHANGEABLE = new Set(['active', 'trialing']);

function conflict(message: string, details: Record<string, unknown>): DemoHttpError {
  return new DemoHttpError(409, 'conflict', message, details);
}

function changeablePlan(): ChannelPlanChoice {
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

function timingFor(plan: ChannelPlanChoice, next: ChannelPlanChoice) {
  const timing = planChangeTiming(plan, next);
  // A trial is charged nothing until it ends: every change applies at once.
  return timing === 'period_end' && current === 'trial' ? 'now' : timing;
}

/** GET /billing/plan/preview: the new price, when it applies and what is due now. */
export function previewPlanChange(next: ChannelPlanChoice): PlanChangePreviewView {
  const plan = changeablePlan();
  const timing = timingFor(plan, next);
  const base = {
    timing,
    current: { ...plan },
    next,
    nextPricePence: unitPrice(next.interval) * next.channels,
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
  const currentPrice = unitPrice(plan.interval) * plan.channels;
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
export function changePlan(next: ChannelPlanChoice): PlanChangeOutcome {
  const plan = changeablePlan();
  const timing = timingFor(plan, next);
  if (timing === 'none') throw conflict('That is already your plan', { reason: 'same' });
  if (timing === 'period_end') {
    const effectiveAt = new Date(periodEndMs()).toISOString();
    pending = { channels: next.channels, interval: next.interval, effectiveAt };
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
  | { kind: 'channels'; channels: number; interval: ChannelInterval }
  | { kind: 'topup'; lookupKey: string }
  | { kind: 'portal' };

/** The hash URL POST /billing/checkout and /billing/portal answer (never Stripe). */
export function checkoutHref(intent: DemoCheckoutIntent): string {
  const q = new URLSearchParams({ kind: intent.kind });
  if (intent.kind === 'channels') {
    q.set('channels', String(intent.channels));
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
  if (kind === 'channels') {
    const channels = Number(search.get('channels'));
    const interval = search.get('interval');
    if (isValidChannelCount(channels) && isChannelInterval(interval))
      return { kind, channels, interval };
  }
  return null;
}

/** Whether completing a channel plan checkout starts the one-per-organisation trial. */
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
  if (intent.kind === 'channels') {
    const trial = startsTrial();
    setBillingState(trial ? 'trial' : 'active_monthly');
    planOverride = { channels: intent.channels, interval: intent.interval };
    if (trial) trialDaysLeft = 14;
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
      `Your plan includes ${short.limit} videos a ${period} and ${short.used} have been generated. Add a channel or buy a video pack for more.`,
      { resource: 'short_videos', used: short.used, limit: short.limit, channelPlan: true },
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

let connectionPlatform: (connectionId: string) => string | null = () => null;

/** p18-billing.ts supplies connection id → platform (publishing past the paid channels). */
export function setConnectionPlatformLookup(lookup: (connectionId: string) => string | null): void {
  connectionPlatform = lookup;
}

function channelGate(method: string, path: string, body: unknown): void {
  if (method !== 'POST' || path !== '/publications') return;
  const usage = channelsInUse();
  const connectionId = obj(body).connectionId;
  if (!usage || typeof connectionId !== 'string') return;
  const platform = connectionPlatform(connectionId);
  if (!platform || usage.allowed.includes(platform)) return;
  const n = usage.paid;
  throw new DemoHttpError(
    403,
    'channel_limit',
    `Your plan includes ${n} ${n === 1 ? 'channel' : 'channels'} (${
      usage.allowed.join(', ') || 'none connected yet'
    }). Add a channel to publish to ${platform}.`,
    { channels: n, platform, allowedPlatforms: usage.allowed },
  );
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
  channelGate(method, path, body);
});
