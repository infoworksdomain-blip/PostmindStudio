import { z } from 'zod';
import type { TenantAccess } from '../../tenant';
import type { PlanTier } from '../providers/router';
import { PLAN_CATALOGUE, planForLookupKey, TIER_ORDER, TRIAL } from './catalogue';
import {
  ALLOWANCE_WINDOW,
  allowanceWindowFor,
  planChangeTiming,
  planForChannelCount,
  planOfSubscription,
  STUDIO_PLANS,
  type PlanChoice,
  type PlanId,
} from './plans';
import type {
  EntitlementLimits,
  Entitlements,
  EntitlementSource,
  PlanEntitlement,
} from './entitlements-reader';

// Phase 18 §P.3 — the ONE place Stripe state becomes Studio state. `entitlementsFromSubscription`
// is pure (no I/O, `now` passed in); billing/sync.ts stores its result in org_entitlements and
// the EntitlementsReader layers admin overrides and the grace clock on top at read time.
//
//   Stripe status                                     Tier                     Access
//   trialing                                          STANDARD (trial limits)  full
//   active                                            the lookup key's tier    full
//   past_due, now < graceUntil (first failure + 7 d)  tier                     full (banner)
//   past_due after grace, unpaid                      tier                     read_only
//   paused (trial ended without a payment method)     tier                     read_only / none*
//   canceled, incomplete_expired, no subscription     BASIC                    read_only / none*
//   incomplete (checkout unfinished)                  BASIC                    none
//   anything else (a status Stripe adds later)        BASIC                    none (fail closed)
//   * read_only when the organisation has paid at least once (export and download stay
//     allowed), none when it never paid.

export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

function days(env: Env, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

/** STUDIO_BILLING_GRACE_DAYS (0–30, default 7). */
export function graceDays(env: Env = process.env): number {
  return days(env, 'STUDIO_BILLING_GRACE_DAYS', DEFAULT_GRACE_DAYS, 30);
}

/** STUDIO_TRIAL_DAYS (0–30, default 7; 0 = no trial). */
export function trialDays(env: Env = process.env): number {
  return days(env, 'STUDIO_TRIAL_DAYS', DEFAULT_TRIAL_DAYS, 30);
}

export function graceEndsAt(firstFailure: Date, env: Env = process.env): Date {
  return new Date(firstFailure.getTime() + graceDays(env) * DAY_MS);
}

export interface SubscriptionFacts {
  status: string;
  lookupKey: string | null;
  productTier: string | null;
  trialEnd: Date | null;
  /** The item quantity (1 on a plan price; the channels on a legacy 21.5 channel price). */
  quantity?: number | null;
}

export interface DerivedEntitlement {
  tier: PlanTier;
  access: TenantAccess;
  source: Extract<EntitlementSource, 'stripe' | 'trial' | 'none'>;
  /** Stripe status the result came from (null = no subscription). */
  status: string | null;
  /** past_due: the end of the grace period (full access until then). */
  graceUntil: Date | null;
  /** 26.1: the plan and interval (a legacy channel price mapped by quantity; null otherwise). */
  plan: PlanChoice | null;
}

/** 26.1: the plan a subscription pays for (a 21.5 channel price is mapped by its quantity). */
export function planChoiceOfSubscription(
  facts: Pick<SubscriptionFacts, 'lookupKey' | 'quantity'>,
): PlanChoice | null {
  const found = planOfSubscription(facts);
  return found ? { plan: found.plan, interval: found.interval } : null;
}

function asTier(value: string | null | undefined): PlanTier | undefined {
  const v = value?.trim().toUpperCase();
  return (TIER_ORDER as readonly string[]).includes(v ?? '') ? (v as PlanTier) : undefined;
}

/** The tier a subscription pays for: the lookup key, else the product's studio_tier (ENTERPRISE). */
export function tierOfSubscription(facts: Pick<SubscriptionFacts, 'lookupKey' | 'productTier'>) {
  return (
    (facts.lookupKey ? planForLookupKey(facts.lookupKey)?.tier : undefined) ??
    asTier(facts.productTier)
  );
}

export function entitlementsFromSubscription(input: {
  subscription: SubscriptionFacts | null;
  now: Date;
  /** The stored end of grace (set at the first failed payment); null = not started yet. */
  graceUntil: Date | null;
  everPaid: boolean;
}): DerivedEntitlement {
  const lapsed: TenantAccess = input.everPaid ? 'read_only' : 'none';
  const sub = input.subscription;
  if (!sub)
    return {
      tier: 'BASIC',
      access: lapsed,
      source: 'none',
      status: null,
      graceUntil: null,
      plan: null,
    };
  const tier = tierOfSubscription(sub) ?? 'BASIC';
  const base = {
    status: sub.status,
    graceUntil: null,
    plan: planChoiceOfSubscription(sub),
  };
  switch (sub.status) {
    case 'trialing':
      return { ...base, tier: TRIAL.tier, access: 'full', source: 'trial' };
    case 'active':
      return { ...base, tier, access: 'full', source: 'stripe' };
    case 'past_due': {
      // Grace starts at the first failure; until the clock is stored it is still running.
      const inGrace = input.graceUntil === null || input.now < input.graceUntil;
      return {
        ...base,
        tier,
        access: inGrace ? 'full' : 'read_only',
        source: 'stripe',
        graceUntil: input.graceUntil,
      };
    }
    case 'unpaid':
      return { ...base, tier, access: 'read_only', source: 'stripe' };
    case 'paused':
      return { ...base, tier, access: lapsed, source: 'stripe' };
    case 'canceled':
    case 'incomplete_expired':
      return { ...base, tier: 'BASIC', access: lapsed, source: 'none', plan: null };
    case 'incomplete':
      return { ...base, tier: 'BASIC', access: 'none', source: 'none', plan: null };
    default:
      return { ...base, tier: 'BASIC', access: 'none', source: 'none', plan: null };
  }
}

// ------------------------------------------------------------------ org_entitlements.overrides

const tierSchema = z.enum(['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE']);
const accessSchema = z.enum(['full', 'read_only', 'none']);
const count = z.number().int().min(0).max(1_000_000).nullable();

/** Custom limits (ENTERPRISE or a staff exception). null = unlimited; absent = the catalogue's. */
export const customLimitsSchema = z
  .object({
    seats: count.optional(),
    businesses: count.optional(),
    storageGb: count.optional(),
    shortVideos: count.optional(),
    longVideos: count.optional(),
    longMaxSec: count.optional(),
    generatedImagesPerBusinessPerMonth: z.number().int().min(0).max(1_000_000).optional(),
    scanBusinesses: count.optional(),
  })
  .strict();

export type CustomLimits = z.infer<typeof customLimitsSchema>;

const intervalSchema = z.enum(['week', 'month', 'year']);
const planIdSchema = z.enum(['starter', 'growth', 'pro']);
/** 21.5 rows stored a channel count; read as a plan by planForChannelCount. */
const channelsSchema = z.number().int().min(1).max(1_000);

export const adminOverrideSchema = z.object({
  tier: tierSchema.optional(),
  access: accessSchema.optional(),
  /** 26.1: staff set the plan and interval (allowance, caps, seats and businesses). */
  plan: planIdSchema.optional(),
  /** 21.5 overrides stored a channel count instead of a plan (read as a plan; never written). */
  channels: channelsSchema.optional(),
  interval: intervalSchema.optional(),
  expiresAt: z.string().nullable().optional(),
  reason: z.string(),
  setByUserId: z.string(),
  setAt: z.string(),
  /** ENTERPRISE: the agreed monthly price, checked against the minimum for the cost cap. */
  monthlyPricePence: z.number().int().nullable().optional(),
});

export const trialStateSchema = z.object({
  startedAt: z.string(),
  endsAt: z.string().nullable(),
  shortVideos: z.number().int(),
  longVideos: z.number().int(),
  dailyCostCapPence: z.number().int(),
  totalCostCapPence: z.number().int(),
  /**
   * 20.27: staff ended the trial early (Admin Centre). From then on the trial's allowance and
   * cost caps never apply again, even while Stripe still reports `trialing` and after a staff
   * override expires or is removed: the plan tier's caps (and any cost-cap override) apply.
   */
  endedAt: z.string().optional(),
  endedByUserId: z.string().optional(),
});

/** 26.3: an upgrade applied now (Stripe proration): when, and the plan before it. */
const planChangeSchema = z.object({
  at: z.string(),
  previousPlan: planIdSchema,
  previousInterval: intervalSchema,
});

export const overridesSchema = z.object({
  derived: z
    .object({
      tier: tierSchema,
      access: accessSchema,
      source: z.enum(['stripe', 'trial', 'none']),
      status: z.string().nullable(),
      /** 26.1: the subscription's plan and interval. */
      plan: planIdSchema.optional(),
      /** 21.5 rows: the quantity on a channel price (read as a plan; no longer written). */
      channels: channelsSchema.optional(),
      interval: intervalSchema.optional(),
      /** 26.3: the last upgrade applied now (blends that window's allowance). */
      planChange: planChangeSchema.optional(),
    })
    .optional(),
  admin: adminOverrideSchema.optional(),
  limits: customLimitsSchema.optional(),
  trial: trialStateSchema.optional(),
  /**
   * Cancelled-organisation retention (open question 3): when a paid organisation's subscription
   * ended, when its owners were told, and when the purge was handed off (billing/retention.ts).
   */
  retention: z
    .object({
      cancelledAt: z.string(),
      notifiedAt: z.string().optional(),
      purgeRequestedAt: z.string().optional(),
    })
    .optional(),
});

/** Stripe statuses after which a paid organisation is "cancelled" (read-only, then purged). */
export const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export type EntitlementOverrides = z.infer<typeof overridesSchema>;
export type PlanChangeRecord = z.infer<typeof planChangeSchema>;
type StoredDerived = NonNullable<EntitlementOverrides['derived']>;
export type AdminOverride = z.infer<typeof adminOverrideSchema>;
export type TrialState = z.infer<typeof trialStateSchema>;

/** Parse the stored JSON; anything malformed is ignored (logged by the caller), never trusted. */
export function parseOverrides(raw: unknown): EntitlementOverrides {
  const parsed = overridesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** The trial allowance and caps: 2 HD videos (26.1), no long video, £10 a day, £15 in total. */
export function trialStateFor(startedAt: Date, endsAt: Date | null): TrialState {
  return {
    startedAt: startedAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
    shortVideos: TRIAL.shortVideos,
    longVideos: TRIAL.longVideos,
    dailyCostCapPence: TRIAL.dailyCostCapPence,
    totalCostCapPence: TRIAL.totalCostCapPence,
  };
}

export interface StoredEntitlement {
  organisationId: string;
  tier: string;
  access: string;
  source: string;
  graceUntil: Date | null;
  overrides: unknown;
  everPaidAt: Date | null;
}

export function adminOverrideActive(admin: AdminOverride | undefined, now: Date): boolean {
  if (!admin) return false;
  if (!admin.expiresAt) return true;
  const at = Date.parse(admin.expiresAt);
  return Number.isNaN(at) ? false : now.getTime() < at;
}

/** Seats and businesses come from the 26.1 plan when there is one, else the tier; custom wins. */
function limitsFor(
  tier: PlanTier,
  studioPlan: PlanId | undefined,
  custom: CustomLimits | undefined,
): EntitlementLimits {
  const catalogue = PLAN_CATALOGUE[tier];
  const plan = studioPlan ? STUDIO_PLANS[studioPlan] : catalogue;
  return {
    seats: custom?.seats !== undefined ? custom.seats : plan.seats,
    businesses: custom?.businesses !== undefined ? custom.businesses : plan.businesses,
    storageGb: custom?.storageGb !== undefined ? custom.storageGb : catalogue.storageGb,
  };
}

/**
 * The effective entitlements of a stored row at `now`: the Stripe-derived value, the grace clock
 * (past_due turns read_only when grace ends, with no event needed), then an unexpired admin
 * override on top.
 */
export function resolveStoredEntitlements(row: StoredEntitlement, now: Date): Entitlements {
  const overrides = parseOverrides(row.overrides);
  const derived = overrides.derived ?? {
    tier: asTier(row.tier) ?? 'BASIC',
    access: accessSchema.catch('none').parse(row.access),
    source: row.source === 'stripe' || row.source === 'trial' ? row.source : 'none',
    status: null,
  };
  let tier: PlanTier = derived.tier;
  let access: TenantAccess = derived.access;
  let source: EntitlementSource = derived.source;
  if (
    derived.status === 'past_due' &&
    access === 'full' &&
    row.graceUntil &&
    now >= row.graceUntil
  ) {
    access = 'read_only';
  }
  const adminActive = adminOverrideActive(overrides.admin, now);
  if (adminActive && overrides.admin) {
    tier = overrides.admin.tier ?? tier;
    access = overrides.admin.access ?? access;
    source = 'admin';
  }
  const custom = adminActive || tier === 'ENTERPRISE' ? overrides.limits : undefined;
  // An active staff override (source admin) or a trial staff ended (20.27) has no trial caps.
  const trial = source === 'trial' && !overrides.trial?.endedAt ? overrides.trial : undefined;
  const plan = resolvePlan(derived, adminActive ? overrides.admin : undefined, tier);
  return {
    tier,
    access,
    source,
    ...(row.graceUntil && derived.status === 'past_due' && { graceUntil: row.graceUntil }),
    limits: limitsFor(tier, plan?.id, custom),
    ...(custom && { custom }),
    ...(trial && { trial }),
    ...(derived.status && { subscriptionStatus: derived.status }),
    ...(plan && { plan }),
  };
}

/**
 * 26.3: the upgrade record to store with a freshly derived Stripe plan. A paid plan that moves
 * UP now (plans.ts planChangeTiming) records when and from which plan; the same plan keeps the
 * record it had; anything else (a downgrade, a first plan, a trial becoming paid: no proration
 * was paid) has none. A second upgrade in the same allowance window keeps the window's first
 * plan with the latest time, so chained upgrades never add more than was paid for.
 */
export function nextPlanChange(
  previous: StoredDerived | undefined,
  next: DerivedEntitlement,
  now: Date,
): PlanChangeRecord | undefined {
  if (next.source !== 'stripe' || !next.plan || previous?.source !== 'stripe') return undefined;
  const before = storedPlan(previous);
  if (!before) return undefined;
  const from: PlanChoice = { plan: before, interval: previous.interval ?? 'month' };
  if (from.plan === next.plan.plan && from.interval === next.plan.interval)
    return previous.planChange;
  if (planChangeTiming(from, next.plan) !== 'now') return undefined;
  const window = allowanceWindowFor(ALLOWANCE_WINDOW[next.plan.interval], now.getTime());
  const earlier =
    previous.planChange && Date.parse(previous.planChange.at) >= window.start.getTime()
      ? previous.planChange
      : undefined;
  return {
    at: now.toISOString(),
    previousPlan: earlier?.previousPlan ?? from.plan,
    previousInterval: earlier?.previousInterval ?? from.interval,
  };
}

/** A stored plan id, or a 21.5 channel count read as a plan. */
function storedPlan(stored: { plan?: PlanId; channels?: number } | undefined): PlanId | undefined {
  if (!stored) return undefined;
  if (stored.plan) return stored.plan;
  return stored.channels !== undefined ? planForChannelCount(stored.channels) : undefined;
}

/**
 * 26.1: the plan in force: a staff override's plan / interval win over the Stripe subscription's
 * (an override may set only one of them; the other comes from Stripe, interval defaulting to
 * month). ENTERPRISE has no plan (custom limits instead).
 */
function resolvePlan(
  derived: {
    plan?: PlanId;
    channels?: number;
    interval?: PlanChoice['interval'];
    planChange?: PlanChangeRecord;
  },
  admin: AdminOverride | undefined,
  tier: PlanTier,
): PlanEntitlement | undefined {
  if (tier === 'ENTERPRISE') return undefined;
  const adminPlan = storedPlan(admin);
  const id = adminPlan ?? storedPlan(derived);
  if (id === undefined) return undefined;
  const interval = admin?.interval ?? derived.interval ?? 'month';
  const fromAdmin = adminPlan !== undefined || admin?.interval !== undefined;
  if (fromAdmin) return { id, interval, source: 'admin' };
  const change = derived.planChange;
  return {
    id,
    interval,
    source: 'stripe',
    ...(change && {
      changedFrom: { plan: change.previousPlan, interval: change.previousInterval, at: change.at },
    }),
  };
}
