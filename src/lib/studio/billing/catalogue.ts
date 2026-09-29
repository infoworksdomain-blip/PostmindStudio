import type { PlanTier } from '../providers/router';

// Phase 18 §P.1 / §P.3 — the plan catalogue: the single source of truth for what each tier
// includes. Amounts (prices) live in Stripe and are read by lookup key; everything else lives
// here. Track 0 moves today's numbers in (plan-quotas.ts DEFAULT_TIER_QUOTAS, cost/caps.ts
// DEFAULT_ORG_*_CAP_PENCE) plus the new limits; Track C points those modules at this object
// (env overrides keep winning: env > catalogue).

export const CATALOGUE_VERSION = '2026-09-29';

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

const common = { shortMaxSec: 30, trialDays: 0 } as const;

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
    dailyCostCapPence: 1_000,
    monthlyCostCapPence: 4_000,
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
    shortVideosPerMonth: 60,
    longVideosPerMonth: 2,
    longMaxSec: 180,
    platforms: 'all',
    dailyCostCapPence: 3_000,
    monthlyCostCapPence: 15_000,
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
    trialDays: 14,
  },
  PLUS: {
    ...common,
    tier: 'PLUS',
    displayOrder: 3,
    selfServe: true,
    shortVideosPerMonth: 150,
    longVideosPerMonth: 8,
    longMaxSec: 360,
    platforms: 'all',
    dailyCostCapPence: 7_500,
    monthlyCostCapPence: 45_000,
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
    dailyCostCapPence: 40_000,
    monthlyCostCapPence: 300_000,
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

/** §P.1 trial: STANDARD features, 5 short + 1 long, £10 a day and £15 in total. */
export const TRIAL = Object.freeze({
  tier: 'STANDARD' as const,
  shortVideos: 5,
  longVideos: 1,
  dailyCostCapPence: 1_000,
  totalCostCapPence: 1_500,
});

export const TOP_UP_PACKS: readonly TopUpPack[] = [
  {
    lookupKey: 'studio_topup_short10_basic',
    tier: 'BASIC',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 200,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_short10_standard',
    tier: 'STANDARD',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 250,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_short10_plus',
    tier: 'PLUS',
    kind: 'short',
    quantity: 10,
    capHeadroomPencePerCredit: 300,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_long2_standard',
    tier: 'STANDARD',
    kind: 'long',
    quantity: 2,
    capHeadroomPencePerCredit: 1_500,
    validMonths: 12,
  },
  {
    lookupKey: 'studio_topup_long2_plus',
    tier: 'PLUS',
    kind: 'long',
    quantity: 2,
    capHeadroomPencePerCredit: 3_000,
    validMonths: 12,
  },
];

/** Lookup key → tier and interval, for the subscription → entitlements mapping (Track C). */
export function planForLookupKey(
  lookupKey: string,
): { tier: PlanTier; interval: BillingInterval } | undefined {
  for (const plan of Object.values(PLAN_CATALOGUE)) {
    for (const [interval, key] of Object.entries(plan.lookupKeys) as [BillingInterval, string][]) {
      if (key === lookupKey) return { tier: plan.tier, interval };
    }
  }
  return undefined;
}

export function topUpPackForLookupKey(lookupKey: string): TopUpPack | undefined {
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

export function lookupKeyFor(tier: SelfServeTier, interval: BillingInterval): string | undefined {
  return PLAN_CATALOGUE[tier].lookupKeys[interval];
}

/** Every Stripe lookup key Studio sells (subscriptions and top-ups), for prices.list. */
export function allLookupKeys(): string[] {
  return [
    ...TIER_ORDER.flatMap((t) => Object.values(PLAN_CATALOGUE[t].lookupKeys)),
    ...TOP_UP_PACKS.map((p) => p.lookupKey),
  ];
}

// ------------------------------------------------------------------ unit economics (§P.2)
// Amounts live in Stripe. REFERENCE_PRICES_PENCE are the §P.2 amounts that
// scripts/billing/seed-stripe-test.ts creates in test mode, and the numbers the profitability
// tests and runbooks/billing-stripe.md check. Changing a live price in Stripe does not change
// them; re-run the margin maths in the runbook when you do.

export const REFERENCE_PRICES_PENCE: Readonly<Record<string, number>> = {
  studio_basic_monthly: 5_900,
  studio_basic_yearly: 59_000,
  studio_standard_monthly: 20_900,
  studio_standard_yearly: 209_000,
  studio_plus_monthly: 74_900,
  studio_plus_yearly: 823_900,
  studio_topup_short10_basic: 2_900,
  studio_topup_short10_standard: 3_900,
  studio_topup_short10_plus: 4_900,
  studio_topup_long2_standard: 3_900,
  studio_topup_long2_plus: 8_900,
};

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

/** Gross margin (0–1) of a top-up pack when every credit spends its full cap headroom. */
export function topUpMarginAtWorstCase(pack: TopUpPack, pricePence: number): number {
  const net = pricePence * (1 - STRIPE_FEE_RATE) - STRIPE_FIXED_FEE_PENCE;
  return (net - pack.quantity * pack.capHeadroomPencePerCredit) / pricePence;
}

/**
 * §P.2 / §P.3 ENTERPRISE minimum monthly price for a custom monthly cost cap C:
 * price × (1 − fees) − fixed fee − infrastructure − C ≥ 15 % × price, i.e.
 * price ≥ (C + fixed + infra) / (1 − fees − 0.15). £3,000 cap → £3,775 (rounded up to a pound).
 */
export function enterpriseMinimumMonthlyPricePence(monthlyCapPence: number): number {
  const raw =
    (monthlyCapPence + STRIPE_FIXED_FEE_PENCE + INFRA_PENCE_PER_MONTH.ENTERPRISE) /
    (1 - STRIPE_FEE_RATE - ENTERPRISE_MIN_MARGIN_AT_CAP);
  return Math.ceil(raw / 100) * 100;
}
