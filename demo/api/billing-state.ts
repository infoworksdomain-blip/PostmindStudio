// The demo organisation's billing state (Phase 18 §P.3), switchable from the demo bar and by a
// `?demoPlan=<state>` query on any tour link. It drives GET /me (plan + banner), GET /billing,
// GET /usage (the tier the lock badges read), the members seat limit, and a request gate that
// answers like the real API: 402 plan_required / billing_required (access gate), 403 plan_tier
// (feature gates) and 403 quota_exceeded (monthly short-video allowance, top-up credits first).
// The choice is kept in a cookie, like the demo's language; purchases made in the simulated
// checkout move the state on, as Stripe's webhooks would.
import {
  PLAN_CATALOGUE,
  TOP_UP_PACKS,
  TRIAL,
  minTierFor,
  minTierForImageLibrary,
  tierAtLeast,
  type BillingInterval,
} from '@/lib/studio/billing/catalogue';
import type { BillingResponse, PlanTier, SelfServeTier } from '@/components/studio/billing/types';
import { demoAccessDecision, type DemoAccess } from './billing-access';
import { DemoHttpError, setRequestGate } from './registry';

export const BILLING_STATES = [
  'trial',
  'active_basic',
  'active_standard',
  'active_plus',
  'past_due',
  'read_only',
  'no_plan',
  'enterprise',
  'cancelled',
] as const;

export type BillingStateId = (typeof BILLING_STATES)[number];

export const DEFAULT_BILLING_STATE: BillingStateId = 'active_standard';

/** Query parameter on a tour link that switches the state before the screen loads. */
export const DEMO_PLAN_PARAM = 'demoPlan';

const COOKIE = 'studio.demoPlan';
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const DAY = 86_400_000;

interface StateInfo {
  label: string;
  tier: PlanTier;
  access: DemoAccess;
  source: 'stripe' | 'trial' | 'admin' | 'none';
  /** Stripe subscription status, or null for no subscription. */
  status: string | null;
  note: string;
}

export const BILLING_STATE_INFO: Record<BillingStateId, StateInfo> = {
  trial: {
    label: 'Trial (Standard)',
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    status: 'trialing',
    note: '14-day Standard trial, 9 days left: 5 short + 1 long video, trial banner.',
  },
  active_basic: {
    label: 'Active: Basic',
    tier: 'BASIC',
    access: 'full',
    source: 'stripe',
    status: 'active',
    note: 'All 20 short videos used this month: generating asks for an upgrade or a top-up.',
  },
  active_standard: {
    label: 'Active: Standard',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'active',
    note: 'The default: 50 of 60 short videos used, Plus features show a lock badge.',
  },
  active_plus: {
    label: 'Active: Plus',
    tier: 'PLUS',
    access: 'full',
    source: 'stripe',
    status: 'active',
    note: 'Voice clone, TEMPLATE mode and AI image generation unlocked.',
  },
  past_due: {
    label: 'Past due (grace)',
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    status: 'past_due',
    note: 'A payment failed: full access for 4 more days, with a banner and the grace date.',
  },
  read_only: {
    label: 'Read-only (unpaid)',
    tier: 'STANDARD',
    access: 'read_only',
    source: 'stripe',
    status: 'unpaid',
    note: 'Grace ended: changes answer 402 billing_required; export and downloads still work.',
  },
  no_plan: {
    label: 'No plan',
    tier: 'BASIC',
    access: 'none',
    source: 'none',
    status: null,
    note: 'Signed up, never subscribed: set up freely, but generate / publish / scan need a plan.',
  },
  enterprise: {
    label: 'Enterprise',
    tier: 'ENTERPRISE',
    access: 'full',
    source: 'admin',
    status: 'active',
    note: 'Staff-set plan with custom limits (40 seats, unlimited videos); no self-serve picker.',
  },
  cancelled: {
    label: 'Cancelled (read-only)',
    tier: 'STANDARD',
    access: 'read_only',
    source: 'stripe',
    status: 'canceled',
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
let interval: BillingInterval = 'month';
let cancelAtPeriodEnd = false;
/** Started in the demo checkout just now: one invoice, dated today (none earlier). */
let freshSubscription = false;
/** Short videos generated in this page load (on top of each state's sample usage). */
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
  cancelAtPeriodEnd = false;
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

/** The monthly video allowance and use: `limit` null = unlimited. */
export function videoQuota(): {
  short: { used: number; limit: number | null };
  long: { used: number; limit: number | null };
} {
  if (current === 'trial')
    return {
      short: { used: 3 + generatedShort, limit: TRIAL.shortVideos },
      long: { used: 0, limit: TRIAL.longVideos },
    };
  const plan = PLAN_CATALOGUE[info().tier];
  // Sample use this month; an organisation that never had a plan has made nothing yet.
  const cap = (base: number, limit: number | null) =>
    current === 'no_plan' ? 0 : limit === null ? base : Math.min(base, limit);
  return {
    short: {
      used: cap(50, plan.shortVideosPerMonth) + generatedShort,
      limit: plan.shortVideosPerMonth,
    },
    long: { used: cap(1, plan.longVideosPerMonth), limit: plan.longVideosPerMonth },
  };
}

function subscription(): BillingResponse['billing']['subscription'] {
  const { status, tier } = info();
  if (!status) return null;
  const lookupKey =
    tier === 'ENTERPRISE' ? null : (PLAN_CATALOGUE[tier].lookupKeys[interval] ?? null);
  const periodDays = current === 'cancelled' ? -2 : current === 'trial' ? 9 : 18;
  return {
    status,
    lookupKey,
    interval,
    currentPeriodEnd: at(periodDays),
    cancelAtPeriodEnd: status === 'active' && cancelAtPeriodEnd,
    trialEnd: current === 'trial' ? trialEnd() : null,
  };
}

/** GET /billing (src/lib/studio/billing/overview.ts shape). */
export function billingOverview(seatsUsed: number): BillingResponse['billing'] {
  const { tier, access, source, status } = info();
  const l = limits();
  const plan = PLAN_CATALOGUE[tier];
  const monthlyCap =
    current === 'trial'
      ? TRIAL.totalCostCapPence
      : current === 'enterprise'
        ? 300_000
        : plan.monthlyCostCapPence;
  return {
    catalogueVersion: '2026-09-29',
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
      cost: {
        month: new Date().toISOString().slice(0, 7),
        spentPence: current === 'no_plan' ? 0 : current === 'trial' ? 640 : 4_500,
        capPence: monthlyCap,
        headroomPence: 0,
      },
    },
    canManage: true,
    checkoutEnabled: true,
  };
}

/** GET /me: the plan line and the most urgent account banner. */
export function meBilling(): {
  plan: { tier: string; access: string; source: string };
  banner:
    | { kind: 'trial'; endsAt: string }
    | { kind: 'past_due'; graceUntil: string | null }
    | { kind: 'read_only' }
    | { kind: 'no_plan' }
    | null;
} {
  const { tier, access, source } = info();
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
  return { plan: { tier, access, source }, banner };
}

/**
 * GET /billing/invoices: three months of invoices at the plan's price (the latest open while
 * unpaid); a subscription started in the demo checkout just now has one, dated today (£0 for a
 * trial).
 */
export function invoices(): Array<Record<string, unknown>> {
  if (current === 'no_plan') return [];
  const { tier } = info();
  const key = PLAN_CATALOGUE[tier].lookupKeys[interval];
  const price = current === 'enterprise' ? 395_000 : key === undefined ? 0 : priceOf(key);
  const amount = freshSubscription && current === 'trial' ? 0 : price;
  const failing = current === 'past_due' || current === 'read_only';
  return (freshSubscription ? [0] : [0, 1, 2]).map((months) => ({
    id: `in_demo_${months}`,
    number: `LSD-00${12 - months}`,
    status: failing && months === 0 ? 'open' : 'paid',
    amountDuePence: amount,
    currency: 'gbp',
    createdAt: freshSubscription ? at(0) : at(-(months * 30 + 12)),
    hostedInvoiceUrl: null,
    invoicePdfUrl: null,
  }));
}

let priceLookup: (lookupKey: string) => number = () => 0;

/** p18-billing.ts supplies the reference prices (it owns the pricing view). */
export function setPriceLookup(lookup: (lookupKey: string) => number): void {
  priceLookup = lookup;
}

function priceOf(lookupKey: string): number {
  return priceLookup(lookupKey);
}

// ------------------------------------------------------------------ simulated checkout & portal

export type DemoCheckoutIntent =
  | { kind: 'subscription'; tier: SelfServeTier; interval: BillingInterval }
  | { kind: 'topup'; lookupKey: string }
  | { kind: 'portal' };

/** The hash URL POST /billing/checkout and /billing/portal answer (never Stripe). */
export function checkoutHref(intent: DemoCheckoutIntent): string {
  const q = new URLSearchParams({ kind: intent.kind });
  if (intent.kind === 'subscription') {
    q.set('tier', intent.tier);
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
  if (kind === 'subscription') {
    const tier = search.get('tier');
    const iv = search.get('interval');
    if (
      (tier === 'BASIC' || tier === 'STANDARD' || tier === 'PLUS') &&
      (iv === 'month' || iv === 'year')
    )
      return { kind, tier, interval: iv };
  }
  return null;
}

/** Whether completing this subscription starts the one-per-organisation Standard trial. */
export function startsTrial(tier: SelfServeTier): boolean {
  return current === 'no_plan' && PLAN_CATALOGUE[tier].trialDays > 0;
}

/** "Complete demo payment": what checkout.session.completed would do. */
export function completeCheckout(intent: DemoCheckoutIntent): 'checkout' | 'topup' {
  if (intent.kind === 'topup') {
    const pack = TOP_UP_PACKS.find((p) => p.lookupKey === intent.lookupKey);
    if (pack) credits[pack.kind] += pack.quantity;
    emit();
    return 'topup';
  }
  if (intent.kind === 'subscription') {
    const next: BillingStateId = startsTrial(intent.tier)
      ? 'trial'
      : intent.tier === 'BASIC'
        ? 'active_basic'
        : intent.tier === 'PLUS'
          ? 'active_plus'
          : 'active_standard';
    interval = intent.interval;
    setBillingState(next);
    if (next === 'trial') trialDaysLeft = PLAN_CATALOGUE.STANDARD.trialDays;
    freshSubscription = true;
    emit();
  }
  return 'checkout';
}

/** Customer-portal actions the simulated portal offers. */
export function portalUpdatePayment(): void {
  const next: BillingStateId =
    current === 'past_due' || current === 'read_only' || current === 'cancelled'
      ? 'active_standard'
      : current;
  setBillingState(next);
  emit();
}

export function portalChangePlan(tier: SelfServeTier): void {
  setBillingState(
    tier === 'BASIC' ? 'active_basic' : tier === 'PLUS' ? 'active_plus' : 'active_standard',
  );
}

export function portalCancel(): void {
  cancelAtPeriodEnd = true;
  emit();
}

export function isCancelling(): boolean {
  return cancelAtPeriodEnd;
}

// ------------------------------------------------------------------ request gate

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function requireTier(required: PlanTier, feature: string): void {
  if (tierAtLeast(info().tier, required)) return;
  throw new DemoHttpError(403, 'plan_tier', `This needs the ${required} plan`, {
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
  if (short.limit !== null && short.used >= short.limit) {
    if (credits.short > 0) {
      credits.short -= 1;
      emitUsage();
      return;
    }
    throw new DemoHttpError(403, 'quota_exceeded', 'This month’s short videos are used up', {
      resource: 'short_videos',
      used: short.used,
      limit: short.limit,
    });
  }
  generatedShort += 1;
  emitUsage();
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
