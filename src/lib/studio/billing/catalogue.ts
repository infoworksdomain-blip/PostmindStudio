import type { PlanTier } from '../providers/router';
import {
  LEGACY_CHANNEL_LOOKUP_KEYS,
  legacyChannelIntervalForLookupKey,
  PLAN_IDS,
  PLAN_INTERVALS,
  PLAN_TIER,
  planChoiceForLookupKey,
  planCostCapsPence,
  planLookupKey,
  planLookupKeys,
  planPricePence,
  STUDIO_PLANS,
  type PlanId,
  type PlanInterval,
} from './plans';

// Phase 18 §P.1 / §P.3 — the plan catalogue: the single source of truth for what each tier
// includes. Amounts (prices) live in Stripe and are read by lookup key; everything else lives
// here. Track 0 moves today's numbers in (plan-quotas.ts DEFAULT_TIER_QUOTAS, cost/caps.ts
// DEFAULT_ORG_*_CAP_PENCE) plus the new limits; Track C points those modules at this object
// (env overrides keep winning: env > catalogue).
//
// Phase 26.1 (2026-10-09): customers buy one of three plans, Starter / Growth / Pro (plans.ts);
// every plan is the internal tier STANDARD. The tiers below stay as the INTERNAL feature matrix
// (gates, routing, quality) and for staff overrides and ENTERPRISE; their own lookup keys
// (studio_<basic|standard|plus>_<interval>) are LEGACY: still mapped, but no longer sold. The
// 21.5 per-channel prices (studio_channel_<interval>) are legacy too: read as a plan by quantity
// until scripts/billing/migrate-to-tiers.ts moves them. The packs for sale are the two HD packs.

export const CATALOGUE_VERSION = '2026-10-09';

/** The legacy tier intervals (studio_<tier>_monthly / _yearly). */
export type BillingInterval = 'month' | 'year';
export type SelfServeTier = Exclude<PlanTier, 'ENTERPRISE'>;
export type ImageLibraryLevel = 'stock' | 'stock_scrape' | 'ai_generation' | 'byoc_generation';
export type PlatformAllowance = 'tiktok_instagram_plus_one' | 'all';

export interface PlanDefinition {
  tier: PlanTier;
  displayOrder: number;
  selfServe: boolean;
  /** null = unlimited (fair use). */
  shortVideosPerMonth: number | null;
  longVideosPerMonth: number | null;
  shortMaxSec: number;
  longMaxSec: number | null;
  platforms: PlatformAllowance;
  dailyCostCapPence: number;
  monthlyCostCapPence: number;
  queuePriority: 'normal' | 'high';
  musicAndSfx: boolean;
  voiceClone: boolean;
  renders4k: boolean;
  imageLibrary: ImageLibraryLevel;
  generatedImagesPerBusinessPerMonth: number;
  scanBusinesses: number | null;
  libraryInspire: boolean;
  libraryTemplate: boolean;
  customPresets: boolean;
  byocProviderKeys: boolean;
  whiteLabel: boolean;
  dnsDomainVerification: boolean;
  approvalWorkflows: boolean;
  seats: number | null;
  businesses: number | null;
  storageGb: number | null;
  /** Stripe Price lookup keys (amounts come from Stripe). */
  lookupKeys: Partial<Record<BillingInterval, string>>;
  trialDays: number;
}

export interface TopUpPack {
  lookupKey: string;
  tier: SelfServeTier;
  kind: 'short' | 'long';
  quantity: number;
  /** Cap headroom each consumed credit adds to that month's cost cap. */
  capHeadroomPencePerCredit: number;
  validMonths: number;
}

/** Spec 12.4: the longest SHORT video on every plan; longer counts as a long video. */
export const SHORT_VIDEO_MAX_SEC = 30;

const common = { shortMaxSec: SHORT_VIDEO_MAX_SEC, trialDays: 0 } as const;

export const PLAN_CATALOGUE: Readonly<Record<PlanTier, PlanDefinition>> = {
  BASIC: {
    ...common,
    tier: 'BASIC',
    displayOrder: 1,
    selfServe: true,
    shortVideosPerMonth: 20,
    longVideosPerMonth: 0,
    longMaxSec: 0,
    platforms: 'tiktok_instagram_plus_one',
    dailyCostCapPence: 500,
    monthlyCostCapPence: 2_000,
    queuePriority: 'normal',
    musicAndSfx: false,
    voiceClone: false,
    renders4k: false,
    imageLibrary: 'stock',
    generatedImagesPerBusinessPerMonth: 20,
    scanBusinesses: 1,
    libraryInspire: false,
    libraryTemplate: false,
    customPresets: false,
    byocProviderKeys: false,
    whiteLabel: false,
    dnsDomainVerification: false,
    approvalWorkflows: false,
    seats: 2,
    businesses: 1,
    storageGb: 25,
    lookupKeys: { month: 'studio_basic_monthly', year: 'studio_basic_yearly' },
  },
  STANDARD: {
    ...common,
    tier: 'STANDARD',
    displayOrder: 2,
    selfServe: true,
    shortVideosPerMonth: 40,
    longVideosPerMonth: 1,
    longMaxSec: 180,
    platforms: 'all',
    dailyCostCapPence: 1_500,
    monthlyCostCapPence: 7_300,
    queuePriority: 'normal',
    musicAndSfx: true,
    voiceClone: false,
    renders4k: false,
    imageLibrary: 'stock_scrape',
    generatedImagesPerBusinessPerMonth: 50,
    scanBusinesses: 3,
    libraryInspire: true,
    libraryTemplate: false,
    customPresets: true,
    byocProviderKeys: false,
    whiteLabel: false,
    dnsDomainVerification: false,
    approvalWorkflows: true,
    seats: 5,
    businesses: 3,
    storageGb: 100,
    lookupKeys: { month: 'studio_standard_monthly', year: 'studio_standard_yearly' },
    trialDays: 7,
  },
  PLUS: {
    ...common,
    tier: 'PLUS',
    displayOrder: 3,
    selfServe: true,
    shortVideosPerMonth: 80,
    longVideosPerMonth: 4,
    longMaxSec: 360,
    platforms: 'all',
    dailyCostCapPence: 4_500,
    monthlyCostCapPence: 26_400,
    queuePriority: 'high',
    musicAndSfx: true,
    voiceClone: true,
    renders4k: true,
    imageLibrary: 'ai_generation',
    generatedImagesPerBusinessPerMonth: 200,
    scanBusinesses: 10,
    libraryInspire: true,
    libraryTemplate: true,
    customPresets: true,
    byocProviderKeys: false,
    whiteLabel: false,
    dnsDomainVerification: false,
    approvalWorkflows: true,
    seats: 15,
    businesses: 10,
    storageGb: 500,
    lookupKeys: { month: 'studio_plus_monthly', year: 'studio_plus_yearly' },
  },
  ENTERPRISE: {
    ...common,
    tier: 'ENTERPRISE',
    displayOrder: 4,
    selfServe: false,
    shortVideosPerMonth: null,
    longVideosPerMonth: null,
    longMaxSec: null,
    platforms: 'all',
    dailyCostCapPence: 15_000,
    monthlyCostCapPence: 110_000,
    queuePriority: 'high',
    musicAndSfx: true,
    voiceClone: true,
    renders4k: true,
    imageLibrary: 'byoc_generation',
    generatedImagesPerBusinessPerMonth: 1_000,
    scanBusinesses: null,
    libraryInspire: true,
    libraryTemplate: true,
    customPresets: true,
    byocProviderKeys: true,
    whiteLabel: true,
    dnsDomainVerification: true,
    approvalWorkflows: true,
    seats: null,
    businesses: null,
    storageGb: null,
    lookupKeys: {},
  },
};

/**
 * §P.1 trial: STANDARD features, £10 a day and £15 in total (entitlements.ts). 26.1: 7 days and
 * 2 HD videos (was 14 days and 5). Long videos are not part of any plan, so the trial has none.
 */
export const TRIAL = Object.freeze({
  tier: 'STANDARD' as const,
  shortVideos: 2,
  longVideos: 0,
  dailyCostCapPence: 1_000,
  totalCostCapPence: 1_500,
});

/**
 * The add-ons for sale: one-off HD video packs, valid 3 months, bought any time on any plan
 * (Checkout mode=payment; usage_credits; used after the plan allowance, oldest first). Headroom
 * per credit: £2.50 (the cap rate; the STANDARD typical cost is ~£2.41). The pack PRICES are the
 * operator's (26.1, 2026-10-09: 5 for £17, 15 for £45; the lookup keys carry no amount).
 */
export const TOP_UP_PACKS: readonly TopUpPack[] = [
  {
    lookupKey: 'studio_pack_hd5',
    tier: PLAN_TIER,
    kind: 'short',
    quantity: 5,
    capHeadroomPencePerCredit: 250,
    validMonths: 3,
  },
  {
    lookupKey: 'studio_pack_hd15',
    tier: PLAN_TIER,
    kind: 'short',
    quantity: 15,
    capHeadroomPencePerCredit: 250,
    validMonths: 3,
  },
];

/**
 * The 2026-09-30 per-tier top-ups. Not sold any more; kept so credits bought before 21.5 keep
 * their kind and cost-cap headroom until they expire.
 */
export const LEGACY_TOP_UP_PACKS: readonly TopUpPack[] = [
  {
    lookupKey: 'studio_topup_short10_basic',
    tier: 'BASIC',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 100,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_short10_standard',
    tier: 'STANDARD',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 175,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_short10_plus',
    tier: 'PLUS',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 265,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_long2_standard',
    tier: 'STANDARD',
    kind: 'long',
    quantity: 2,
    capHeadroomPencePerCredit: 1_000,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_long2_plus',
    tier: 'PLUS',
    kind: 'long',
    quantity: 2,
    capHeadroomPencePerCredit: 2_000,
    validMonths: 12,
  },
];

/**
 * Lookup key → tier and interval, for the subscription → entitlements mapping. The plan prices
 * (26.1) and the legacy per-channel prices (21.5) are STANDARD (`studioPlan`); the legacy
 * studio_<tier>_<interval> keys map to their old tier.
 */
export function planForLookupKey(
  lookupKey: string,
): { tier: PlanTier; interval: PlanInterval; studioPlan: boolean } | undefined {
  const interval =
    planChoiceForLookupKey(lookupKey)?.interval ?? legacyChannelIntervalForLookupKey(lookupKey);
  if (interval) return { tier: PLAN_TIER, interval, studioPlan: true };
  for (const plan of Object.values(PLAN_CATALOGUE)) {
    for (const [interval, key] of Object.entries(plan.lookupKeys) as [BillingInterval, string][]) {
      if (key === lookupKey) return { tier: plan.tier, interval, studioPlan: false };
    }
  }
  return undefined;
}

/** A pack by lookup key: the packs for sale, then the legacy ones (crediting, headroom). */
export function topUpPackForLookupKey(lookupKey: string): TopUpPack | undefined {
  return (
    TOP_UP_PACKS.find((p) => p.lookupKey === lookupKey) ??
    LEGACY_TOP_UP_PACKS.find((p) => p.lookupKey === lookupKey)
  );
}

/** A pack that can be bought today (Checkout refuses the legacy ones). */
export function sellableTopUpPack(lookupKey: string): TopUpPack | undefined {
  return TOP_UP_PACKS.find((p) => p.lookupKey === lookupKey);
}

// ------------------------------------------------------------------ Track C helpers (Phase 18 §P.3)

/** Tiers from lowest to highest (display order). */
export const TIER_ORDER: readonly PlanTier[] = (Object.values(PLAN_CATALOGUE) as PlanDefinition[])
  .slice()
  .sort((a, b) => a.displayOrder - b.displayOrder)
  .map((p) => p.tier);

export function tierRank(tier: PlanTier): number {
  return TIER_ORDER.indexOf(tier);
}

export function tierAtLeast(tier: PlanTier, minTier: PlanTier): boolean {
  return tierRank(tier) >= tierRank(minTier);
}

/** The boolean feature switches of a plan (music, voice clone, 4K, …). */
export type PlanFeatureFlag = {
  [K in keyof PlanDefinition]-?: PlanDefinition[K] extends boolean ? K : never;
}[keyof PlanDefinition];

/**
 * The lowest tier that includes `flag` (the "min tier" the gates enforce). Every flag is on for
 * ENTERPRISE, so this always answers.
 */
export function minTierFor(flag: Exclude<PlanFeatureFlag, 'selfServe'>): PlanTier {
  return TIER_ORDER.find((tier) => PLAN_CATALOGUE[tier][flag]) ?? 'ENTERPRISE';
}

/** The lowest tier whose image library reaches `level` (stock < scrape < AI < BYOC). */
const IMAGE_LEVELS: readonly ImageLibraryLevel[] = [
  'stock',
  'stock_scrape',
  'ai_generation',
  'byoc_generation',
];
export function minTierForImageLibrary(level: ImageLibraryLevel): PlanTier {
  const wanted = IMAGE_LEVELS.indexOf(level);
  return (
    TIER_ORDER.find((tier) => IMAGE_LEVELS.indexOf(PLAN_CATALOGUE[tier].imageLibrary) >= wanted) ??
    'ENTERPRISE'
  );
}

export function selfServeTiers(): SelfServeTier[] {
  return TIER_ORDER.filter((t): t is SelfServeTier => PLAN_CATALOGUE[t].selfServe);
}

/** A legacy tier's lookup key (no longer sold). */
export function lookupKeyFor(tier: SelfServeTier, interval: BillingInterval): string | undefined {
  return PLAN_CATALOGUE[tier].lookupKeys[interval];
}

/** The legacy tier lookup keys (studio_<tier>_<interval>), for the ops migration. */
export function legacyLookupKeys(): string[] {
  return TIER_ORDER.flatMap((t) => Object.values(PLAN_CATALOGUE[t].lookupKeys));
}

/** Every Stripe lookup key Studio sells (the 9 plan prices and the packs), for prices.list. */
export function allLookupKeys(): string[] {
  return [...planLookupKeys(), ...TOP_UP_PACKS.map((p) => p.lookupKey)];
}

// ------------------------------------------------------------------ unit economics (§P.2)
// Amounts live in Stripe. REFERENCE_PRICES_PENCE are the §P.2 amounts that
// scripts/billing/seed-stripe-test.ts creates in test mode, and the numbers the profitability
// tests and runbooks/billing-stripe.md check. Changing a live price in Stripe does not change
// them; re-run the margin maths in the runbook when you do.

export const REFERENCE_PRICES_PENCE: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    PLAN_IDS.flatMap((plan) =>
      PLAN_INTERVALS.map((interval) => [
        planLookupKey(plan, interval),
        planPricePence(plan, interval),
      ]),
    ),
  ),
  studio_pack_hd5: 1_700,
  studio_pack_hd15: 4_500,
};

/**
 * Earlier prices on legacy keys (test fixtures and the ops migrations only): the 21.5 per-channel
 * prices (per channel) and the 2026-09-30 tier prices.
 */
export const LEGACY_REFERENCE_PRICES_PENCE: Readonly<Record<string, number>> = {
  [LEGACY_CHANNEL_LOOKUP_KEYS.week]: 950,
  [LEGACY_CHANNEL_LOOKUP_KEYS.month]: 2_900,
  [LEGACY_CHANNEL_LOOKUP_KEYS.year]: 29_000,
  studio_basic_monthly: 2_900,
  studio_basic_yearly: 29_000,
  studio_standard_monthly: 9_900,
  studio_standard_yearly: 99_000,
  studio_plus_monthly: 34_900,
  studio_plus_yearly: 349_000,
  studio_topup_short10_basic: 1_500,
  studio_topup_short10_standard: 2_500,
  studio_topup_short10_plus: 3_500,
  studio_topup_long2_standard: 2_900,
  studio_topup_long2_plus: 5_500,
};

/**
 * ENTERPRISE list price ("from £1,500 a month", §P.2 revised 2026-09-30). Staff quote per
 * customer; the admin console still refuses a price below `enterpriseMinimumMonthlyPricePence`
 * for the organisation's custom monthly cost cap.
 */
export const ENTERPRISE_LIST_PRICE_PENCE = 150_000;

/** §P.2 typical provider cost per video (estimates; recheck with real provider_usage). */
export const TYPICAL_COST_PENCE_PER_VIDEO: Readonly<
  Record<SelfServeTier, { short: number; long: number }>
> = {
  BASIC: { short: 90, long: 0 },
  // 21.5 (coordinator 2026-10-04, p21-tiered-models): Seedance 2.0 full at 720p on every tier,
  // a typical 30 s STANDARD short is ~241p (233–241p; 141p on Mini, 160p in the 2026-09-29 table).
  STANDARD: { short: 241, long: 900 },
  PLUS: { short: 240, long: 1_800 },
};

/** Provider cost of a self-serve tier's whole monthly allowance at the typical per-video cost. */
export function fullAllowanceTypicalCostPence(tier: SelfServeTier): number {
  const plan = PLAN_CATALOGUE[tier];
  const cost = TYPICAL_COST_PENCE_PER_VIDEO[tier];
  return (plan.shortVideosPerMonth ?? 0) * cost.short + (plan.longVideosPerMonth ?? 0) * cost.long;
}

/** Worst-case Stripe fees (§P.2): 3.25 % international card + 0.7 % Billing + 0.5 % Tax. */
export const STRIPE_FEE_RATE = 0.0445;
/** Fixed card fee per invoice. */
export const STRIPE_FIXED_FEE_PENCE = 20;
/** Shared infrastructure and email per organisation per month (§P.2 estimates). */
export const INFRA_PENCE_PER_MONTH: Readonly<Record<PlanTier, number>> = {
  BASIC: 200,
  STANDARD: 400,
  PLUS: 800,
  ENTERPRISE: 4_000,
};
/** The minimum gross margin at the cost cap an ENTERPRISE override must keep (§P.2). */
export const ENTERPRISE_MIN_MARGIN_AT_CAP = 0.15;

/** Gross margin (0–1) of a subscription when the organisation spends its whole monthly cap. */
export function grossMarginAtCap(input: {
  tier: PlanTier;
  interval: BillingInterval;
  pricePence: number;
  monthlyCapPence?: number;
}): number {
  const months = input.interval === 'year' ? 12 : 1;
  const monthlyPrice = input.pricePence / months;
  const net =
    monthlyPrice * (1 - STRIPE_FEE_RATE) -
    STRIPE_FIXED_FEE_PENCE / months -
    INFRA_PENCE_PER_MONTH[input.tier];
  const cap = input.monthlyCapPence ?? PLAN_CATALOGUE[input.tier].monthlyCostCapPence;
  return (net - cap) / monthlyPrice;
}

/** §P.2 typical use: half of the monthly allowance at the typical per-video cost. */
export const TYPICAL_USE_SHARE = 0.5;

/** Gross margin (0–1) of a self-serve subscription at typical use (§P.2). */
export function grossMarginTypical(input: {
  tier: SelfServeTier;
  interval: BillingInterval;
  pricePence: number;
}): number {
  return grossMarginAtCap({
    ...input,
    monthlyCapPence: fullAllowanceTypicalCostPence(input.tier) * TYPICAL_USE_SHARE,
  });
}

/** Invoices a month per plan interval. */
const INVOICES_PER_MONTH: Readonly<Record<PlanInterval, number>> = {
  week: 52 / 12,
  month: 1,
  year: 1 / 12,
};

/** A plan's price as a monthly figure (weekly × 52 ÷ 12, yearly ÷ 12). */
export function planMonthlyEquivalentPence(
  plan: PlanId,
  interval: PlanInterval,
  pricePence: number = planPricePence(plan, interval),
): number {
  return pricePence * INVOICES_PER_MONTH[interval];
}

/**
 * 26.1 unit economics of a plan (internal; runbooks/billing-stripe.md §5): monthly-equivalent
 * price less worst-case Stripe fees (per invoice), STANDARD infrastructure and the provider spend.
 * `spendPence` defaults to the plan's whole monthly cost cap (the worst case).
 */
export function planGrossMargin(input: {
  plan: PlanId;
  interval: PlanInterval;
  pricePence?: number;
  spendPence?: number;
}): number {
  const price = planMonthlyEquivalentPence(input.plan, input.interval, input.pricePence);
  const net =
    price * (1 - STRIPE_FEE_RATE) -
    STRIPE_FIXED_FEE_PENCE * INVOICES_PER_MONTH[input.interval] -
    INFRA_PENCE_PER_MONTH[PLAN_TIER];
  const spend = input.spendPence ?? planCostCapsPence(input.plan, input.interval).monthlyPence;
  return (net - spend) / price;
}

/** §P.2 typical use for a plan: half its monthly videos at the STANDARD typical cost. */
export function planTypicalSpendPence(plan: PlanId, interval: PlanInterval): number {
  const def = STUDIO_PLANS[plan];
  const perMonth = interval === 'week' ? (def.videosPerWeek * 52) / 12 : def.videosPerMonth;
  return perMonth * TYPICAL_USE_SHARE * TYPICAL_COST_PENCE_PER_VIDEO[PLAN_TIER].short;
}

/** Gross margin (0–1) of a top-up pack when every credit spends its full cap headroom. */
export function topUpMarginAtWorstCase(pack: TopUpPack, pricePence: number): number {
  const net = pricePence * (1 - STRIPE_FEE_RATE) - STRIPE_FIXED_FEE_PENCE;
  return (net - pack.quantity * pack.capHeadroomPencePerCredit) / pricePence;
}

/**
 * §P.2 / §P.3 ENTERPRISE minimum monthly price for a custom monthly cost cap C:
 * price × (1 − fees) − fixed fee − infrastructure − C ≥ 15 % × price, i.e.
 * price ≥ (C + fixed + infra) / (1 − fees − 0.15). £1,100 cap → £1,416 (rounded up to a pound).
 */
export function enterpriseMinimumMonthlyPricePence(monthlyCapPence: number): number {
  const raw =
    (monthlyCapPence + STRIPE_FIXED_FEE_PENCE + INFRA_PENCE_PER_MONTH.ENTERPRISE) /
    (1 - STRIPE_FEE_RATE - ENTERPRISE_MIN_MARGIN_AT_CAP);
  return Math.ceil(raw / 100) * 100;
}
