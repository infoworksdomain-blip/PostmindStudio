import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_DAILY_CAP_PENCE, DEFAULT_ORG_MONTHLY_CAP_PENCE } from '../cost/caps';
import { DEFAULT_MUSIC_MIN_TIER } from '../pipeline/music';
import { FOUR_K_TIERS } from '../pipeline/render-presets';
import { priorityFor, PRIORITY } from '../queue/queues';
import { DEFAULT_TIER_QUOTAS } from '../services/plan-quotas';
import {
  DEFAULT_IMAGE_GENERATION_MONTHLY_CAP,
  SCANNED_BUSINESS_LIMITS,
  TIER_GATES,
} from '../services/tier-gates';
import { DEFAULT_VOICE_CLONE_MIN_TIER } from '../services/voice-profiles';
import {
  allLookupKeys,
  CATALOGUE_VERSION,
  ENTERPRISE_LIST_PRICE_PENCE,
  enterpriseMinimumMonthlyPricePence,
  fullAllowanceTypicalCostPence,
  grossMarginAtCap,
  grossMarginTypical,
  lookupKeyFor,
  minTierFor,
  minTierForImageLibrary,
  PLAN_CATALOGUE,
  planForLookupKey,
  REFERENCE_PRICES_PENCE,
  selfServeTiers,
  TIER_ORDER,
  tierAtLeast,
  TOP_UP_PACKS,
  topUpMarginAtWorstCase,
  TYPICAL_COST_PENCE_PER_VIDEO,
  topUpPackForLookupKey,
} from './catalogue';
import { createStubEntitlementsReader, NO_PLAN_ENTITLEMENTS } from './entitlements-reader';

describe('PLAN_CATALOGUE (Phase 18 §P.1)', () => {
  it('holds the §P.1 numbers (quotas, caps, limits) — pinned literally', () => {
    const rows = TIER_ORDER.map((t) => {
      const p = PLAN_CATALOGUE[t];
      return [
        t,
        p.shortVideosPerMonth,
        p.longVideosPerMonth,
        p.longMaxSec,
        p.dailyCostCapPence,
        p.monthlyCostCapPence,
        p.generatedImagesPerBusinessPerMonth,
        p.scanBusinesses,
        p.seats,
        p.businesses,
        p.storageGb,
      ];
    });
    expect(rows).toEqual([
      ['BASIC', 20, 0, 0, 500, 2_000, 20, 1, 2, 1, 25],
      ['STANDARD', 40, 1, 180, 2_000, 7_300, 50, 3, 5, 3, 100],
      ['PLUS', 80, 4, 360, 9_000, 26_400, 200, 10, 15, 10, 500],
      ['ENTERPRISE', null, null, null, 15_000, 110_000, 1_000, null, null, null, null],
    ]);
  });

  it('every consumer reads its defaults from the catalogue', () => {
    for (const plan of Object.values(PLAN_CATALOGUE)) {
      const q = DEFAULT_TIER_QUOTAS[plan.tier];
      expect(plan.shortVideosPerMonth, plan.tier).toBe(q.shortVideos);
      expect(plan.longVideosPerMonth, plan.tier).toBe(q.longVideos);
      expect(plan.shortMaxSec, plan.tier).toBe(q.shortMaxSec);
      expect(plan.longMaxSec, plan.tier).toBe(q.longMaxSec);
      expect(plan.platforms, plan.tier).toBe(q.platforms);
      expect(plan.dailyCostCapPence, plan.tier).toBe(DEFAULT_ORG_DAILY_CAP_PENCE[plan.tier]);
      expect(plan.monthlyCostCapPence, plan.tier).toBe(DEFAULT_ORG_MONTHLY_CAP_PENCE[plan.tier]);
      expect(plan.scanBusinesses, plan.tier).toBe(SCANNED_BUSINESS_LIMITS[plan.tier]);
      expect(plan.generatedImagesPerBusinessPerMonth).toBe(
        DEFAULT_IMAGE_GENERATION_MONTHLY_CAP[plan.tier],
      );
      expect(FOUR_K_TIERS.has(plan.tier)).toBe(plan.renders4k);
      expect(priorityFor(plan.tier)).toBe(
        plan.queuePriority === 'high' ? PRIORITY.high : PRIORITY.normal,
      );
    }
    expect(DEFAULT_MUSIC_MIN_TIER).toBe('STANDARD');
    expect(DEFAULT_VOICE_CLONE_MIN_TIER).toBe('PLUS');
    expect(TIER_GATES['library.inspire'].minTier).toBe('STANDARD');
    expect(TIER_GATES['library.template'].minTier).toBe('PLUS');
    expect(TIER_GATES['image_library.generate'].minTier).toBe('PLUS');
    expect(TIER_GATES['approval.workflows'].minTier).toBe('STANDARD');
  });

  it('answers minimum tiers and tier order', () => {
    expect(TIER_ORDER).toEqual(['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE']);
    expect(minTierFor('voiceClone')).toBe('PLUS');
    expect(minTierFor('byocProviderKeys')).toBe('ENTERPRISE');
    expect(minTierFor('whiteLabel')).toBe('ENTERPRISE');
    expect(minTierForImageLibrary('stock')).toBe('BASIC');
    expect(minTierForImageLibrary('stock_scrape')).toBe('STANDARD');
    expect(minTierForImageLibrary('byoc_generation')).toBe('ENTERPRISE');
    expect(tierAtLeast('PLUS', 'STANDARD')).toBe(true);
    expect(tierAtLeast('BASIC', 'STANDARD')).toBe(false);
    expect(selfServeTiers()).toEqual(['BASIC', 'STANDARD', 'PLUS']);
    expect(lookupKeyFor('PLUS', 'year')).toBe('studio_plus_yearly');
  });

  it('maps every self-serve lookup key back to its tier and interval', () => {
    expect(planForLookupKey('studio_standard_yearly')).toEqual({
      tier: 'STANDARD',
      interval: 'year',
    });
    expect(planForLookupKey('studio_basic_monthly')).toEqual({ tier: 'BASIC', interval: 'month' });
    expect(planForLookupKey('studio_enterprise_monthly')).toBeUndefined();
    const keys = allLookupKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(11);
    expect(Object.keys(REFERENCE_PRICES_PENCE).sort()).toEqual([...keys].sort());
  });

  it('only offers the trial on STANDARD and no long-video pack on BASIC', () => {
    expect(
      Object.values(PLAN_CATALOGUE)
        .filter((p) => p.trialDays > 0)
        .map((p) => p.tier),
    ).toEqual(['STANDARD']);
    expect(TOP_UP_PACKS.some((p) => p.tier === 'BASIC' && p.kind === 'long')).toBe(false);
    expect(topUpPackForLookupKey('studio_topup_long2_plus')?.quantity).toBe(2);
    expect(topUpPackForLookupKey('nope')).toBeUndefined();
  });
});

describe('§P.2 unit economics (price list 2026-09-30)', () => {
  const margin = (key: string) => {
    const plan = planForLookupKey(key);
    if (!plan) throw new Error(key);
    return grossMarginAtCap({ ...plan, pricePence: REFERENCE_PRICES_PENCE[key] ?? 0 });
  };
  const typical = (key: string) => {
    const plan = planForLookupKey(key);
    if (!plan || plan.tier === 'ENTERPRISE') throw new Error(key);
    return grossMarginTypical({
      tier: plan.tier,
      interval: plan.interval,
      pricePence: REFERENCE_PRICES_PENCE[key] ?? 0,
    });
  };
  const monthlyKeys = selfServeTiers().map((t) => lookupKeyFor(t, 'month') ?? '');

  it('holds the 2026-09-30 reference prices (annual = 10 × monthly)', () => {
    expect(CATALOGUE_VERSION).toBe('2026-09-30');
    expect(REFERENCE_PRICES_PENCE).toEqual({
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
    });
    for (const tier of selfServeTiers())
      expect(REFERENCE_PRICES_PENCE[lookupKeyFor(tier, 'year') ?? '']).toBe(
        10 * (REFERENCE_PRICES_PENCE[lookupKeyFor(tier, 'month') ?? ''] ?? 0),
      );
    expect(TOP_UP_PACKS.map((p) => [p.lookupKey, p.capHeadroomPencePerCredit])).toEqual([
      ['studio_topup_short10_basic', 100],
      ['studio_topup_short10_standard', 175],
      ['studio_topup_short10_plus', 265],
      ['studio_topup_long2_standard', 1_000],
      ['studio_topup_long2_plus', 2_000],
    ]);
  });

  it('matches the runbook table (margin at the cap and at typical use)', () => {
    expect(margin('studio_basic_monthly')).toBeCloseTo(0.19, 3);
    expect(margin('studio_standard_monthly')).toBeCloseTo(0.1757, 3);
    expect(margin('studio_plus_monthly')).toBeCloseTo(0.1756, 3);
    expect(margin('studio_basic_yearly')).toBeCloseTo(0.0445, 3);
    expect(margin('studio_standard_yearly')).toBeCloseTo(0.022, 3);
    expect(margin('studio_plus_yearly')).toBeCloseTo(0.0202, 3);
    expect(typical('studio_basic_monthly')).toBeCloseTo(0.5693, 3);
    expect(typical('studio_standard_monthly')).toBeCloseTo(0.5444, 3);
    expect(typical('studio_plus_monthly')).toBeCloseTo(0.5538, 3);
    expect(typical('studio_basic_yearly')).toBeCloseTo(0.4996, 3);
    expect(typical('studio_standard_yearly')).toBeCloseTo(0.4644, 3);
    expect(typical('studio_plus_yearly')).toBeCloseTo(0.4741, 3);
  });

  it('guard: every monthly plan keeps ≥ 50 % at typical use and ≥ 15 % at its cost cap', () => {
    for (const key of monthlyKeys) {
      expect(typical(key), key).toBeGreaterThanOrEqual(0.5);
      expect(margin(key), key).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('every self-serve price stays positive at the cap', () => {
    for (const tier of selfServeTiers())
      for (const key of Object.values(PLAN_CATALOGUE[tier].lookupKeys))
        expect(margin(key), key).toBeGreaterThan(0);
  });

  it('guard: the monthly cost cap covers the whole allowance at the typical per-video cost', () => {
    // Otherwise a customer is paused before they have used the videos they paid for.
    expect(selfServeTiers().map((t) => fullAllowanceTypicalCostPence(t))).toEqual([
      1_800, 7_300, 26_400,
    ]);
    for (const tier of selfServeTiers())
      expect(PLAN_CATALOGUE[tier].monthlyCostCapPence, tier).toBeGreaterThanOrEqual(
        fullAllowanceTypicalCostPence(tier),
      );
  });

  it('every top-up pack stays above 15 % in the worst case', () => {
    const margins = TOP_UP_PACKS.map((pack) =>
      topUpMarginAtWorstCase(pack, REFERENCE_PRICES_PENCE[pack.lookupKey] ?? 0),
    );
    for (const [i, m] of margins.entries())
      expect(m, TOP_UP_PACKS[i]?.lookupKey).toBeGreaterThan(0.15);
    expect(margins.map((m) => Math.round(m * 1000) / 1000)).toEqual([
      0.276, 0.248, 0.193, 0.259, 0.225,
    ]);
  });

  it('every top-up credit adds at least its typical per-video cost to the cap', () => {
    for (const pack of TOP_UP_PACKS) {
      const typicalCost = TYPICAL_COST_PENCE_PER_VIDEO[pack.tier][pack.kind];
      expect(pack.capHeadroomPencePerCredit, pack.lookupKey).toBeGreaterThanOrEqual(typicalCost);
    }
  });

  it('ENTERPRISE minimum price keeps 15 % at a custom cap (£1,100 cap → £1,416)', () => {
    const defaultCap = PLAN_CATALOGUE.ENTERPRISE.monthlyCostCapPence;
    expect(defaultCap).toBe(110_000);
    expect(enterpriseMinimumMonthlyPricePence(defaultCap)).toBe(141_600);
    expect(enterpriseMinimumMonthlyPricePence(300_000)).toBe(377_500);
    for (const cap of [100_000, defaultCap, 300_000, 1_000_000]) {
      const min = enterpriseMinimumMonthlyPricePence(cap);
      expect(
        grossMarginAtCap({
          tier: 'ENTERPRISE',
          interval: 'month',
          pricePence: min,
          monthlyCapPence: cap,
        }),
      ).toBeGreaterThanOrEqual(0.15);
    }
    // The list price "from £1,500" is at or above the default minimum.
    expect(ENTERPRISE_LIST_PRICE_PENCE).toBe(150_000);
    expect(ENTERPRISE_LIST_PRICE_PENCE).toBeGreaterThanOrEqual(
      enterpriseMinimumMonthlyPricePence(defaultCap),
    );
  });
});

describe('createStubEntitlementsReader', () => {
  it('answers "no plan"', async () => {
    const reader = createStubEntitlementsReader();
    await expect(reader.forOrganisation('org-1')).resolves.toBe(NO_PLAN_ENTITLEMENTS);
    expect(() => reader.invalidate('org-1')).not.toThrow();
    expect(NO_PLAN_ENTITLEMENTS.access).toBe('none');
  });
});
