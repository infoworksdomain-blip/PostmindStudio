import { z } from 'zod';
import type { TenantAccess } from '../../tenant';
import type { PlanTier } from '../providers/router';
import { PLAN_CATALOGUE, planForLookupKey, TIER_ORDER, TRIAL } from './catalogue';
import type { EntitlementLimits, Entitlements, EntitlementSource } from './entitlements-reader';

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
export const DEFAULT_TRIAL_DAYS = 14;
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

/** STUDIO_TRIAL_DAYS (0–30, default 14; 0 = no trial). */
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
}

export interface DerivedEntitlement {
  tier: PlanTier;
  access: TenantAccess;
  source: Extract<EntitlementSource, 'stripe' | 'trial' | 'none'>;
  /** Stripe status the result came from (null = no subscription). */
  status: string | null;
  /** past_due: the end of the grace period (full access until then). */
  graceUntil: Date | null;
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
    return { tier: 'BASIC', access: lapsed, source: 'none', status: null, graceUntil: null };
  const tier = tierOfSubscription(sub) ?? 'BASIC';
  const base = { status: sub.status, graceUntil: null };
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
      return { ...base, tier: 'BASIC', access: lapsed, source: 'none' };
    case 'incomplete':
      return { ...base, tier: 'BASIC', access: 'none', source: 'none' };
    default:
      return { ...base, tier: 'BASIC', access: 'none', source: 'none' };
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

export const adminOverrideSchema = z.object({
  tier: tierSchema.optional(),
  access: accessSchema.optional(),
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
});

export const overridesSchema = z.object({
  derived: z
    .object({
      tier: tierSchema,
      access: accessSchema,
      source: z.enum(['stripe', 'trial', 'none']),
      status: z.string().nullable(),
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
export type AdminOverride = z.infer<typeof adminOverrideSchema>;
export type TrialState = z.infer<typeof trialStateSchema>;

/** Parse the stored JSON; anything malformed is ignored (logged by the caller), never trusted. */
export function parseOverrides(raw: unknown): EntitlementOverrides {
  const parsed = overridesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** The trial allowance and caps (§P.1): 5 short, 1 long, £10 a day, £15 in total. */
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

function limitsFor(tier: PlanTier, custom: CustomLimits | undefined): EntitlementLimits {
  const plan = PLAN_CATALOGUE[tier];
  return {
    seats: custom?.seats !== undefined ? custom.seats : plan.seats,
    businesses: custom?.businesses !== undefined ? custom.businesses : plan.businesses,
    storageGb: custom?.storageGb !== undefined ? custom.storageGb : plan.storageGb,
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
  const trial = source === 'trial' ? overrides.trial : undefined;
  return {
    tier,
    access,
    source,
    ...(row.graceUntil && derived.status === 'past_due' && { graceUntil: row.graceUntil }),
    limits: limitsFor(tier, custom),
    ...(custom && { custom }),
    ...(trial && { trial }),
    ...(derived.status && { subscriptionStatus: derived.status }),
  };
}
