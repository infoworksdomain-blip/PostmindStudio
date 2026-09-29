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
  enterpriseMinimumMonthlyPricePence,
  grossMarginAtCap,
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
      ['BASIC', 20, 0, 0, 1_000, 4_000, 20, 1, 2, 1, 25],
      ['STANDARD', 60, 2, 180, 3_000, 15_000, 50, 3, 5, 3, 100],
      ['PLUS', 150, 8, 360, 7_500, 45_000, 200, 10, 15, 10, 500],
      ['ENTERPRISE', null, null, null, 40_000, 300_000, 1_000, null, null, null, null],
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

describe('§P.2 unit economics: every tier is profitable at its cost cap', () => {
  const margin = (key: string) => {
    const plan = planForLookupKey(key);
    if (!plan) throw new Error(key);
    return grossMarginAtCap({ ...plan, pricePence: REFERENCE_PRICES_PENCE[key] ?? 0 });
  };

  it('matches the §P.2 table (margin at the cap)', () => {
    expect(margin('studio_basic_monthly')).toBeCloseTo(0.24, 2);
    expect(margin('studio_standard_monthly')).toBeCloseTo(0.218, 2);
    expect(margin('studio_plus_monthly')).toBeCloseTo(0.344, 2);
    expect(margin('studio_basic_yearly')).toBeCloseTo(0.101, 2);
    expect(margin('studio_standard_yearly')).toBeCloseTo(0.071, 2);
    // §P.2 prints 28.0 %; (648.02 − 450) / 686.58 is 28.8 % (runbooks/billing-stripe.md).
    expect(margin('studio_plus_yearly')).toBeCloseTo(0.288, 2);
  });

  it('every self-serve price stays positive at the cap', () => {
    for (const tier of selfServeTiers())
      for (const key of Object.values(PLAN_CATALOGUE[tier].lookupKeys))
        expect(margin(key), key).toBeGreaterThan(0);
  });

  it('every top-up pack stays positive in the worst case', () => {
    for (const pack of TOP_UP_PACKS) {
      const m = topUpMarginAtWorstCase(pack, REFERENCE_PRICES_PENCE[pack.lookupKey] ?? 0);
      expect(m, pack.lookupKey).toBeGreaterThan(0.15);
    }
  });

  it('ENTERPRISE minimum price keeps 15 % at a custom cap (£3,000 cap → £3,775)', () => {
    expect(enterpriseMinimumMonthlyPricePence(300_000)).toBe(377_500);
    for (const cap of [100_000, 300_000, 1_000_000]) {
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
    // The list price "from £3,950" is above the default minimum.
    expect(395_000).toBeGreaterThan(enterpriseMinimumMonthlyPricePence(300_000));
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
