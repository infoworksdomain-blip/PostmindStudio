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
  channelGrossMargin,
  channelPlanMonthlyEquivalentPence,
  channelTypicalSpendPence,
  LEGACY_REFERENCE_PRICES_PENCE,
  LEGACY_TOP_UP_PACKS,
  legacyLookupKeys,
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
  sellableTopUpPack,
  selfServeTiers,
  TIER_ORDER,
  tierAtLeast,
  TOP_UP_PACKS,
  topUpMarginAtWorstCase,
  TRIAL,
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
      ['STANDARD', 40, 1, 180, 1_500, 7_300, 50, 3, 5, 3, 100],
      ['PLUS', 80, 4, 360, 4_500, 26_400, 200, 10, 15, 10, 500],
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

  it('maps lookup keys back to tier and interval: channel prices are STANDARD (21.5)', () => {
    expect(planForLookupKey('studio_channel_monthly')).toEqual({
      tier: 'STANDARD',
      interval: 'month',
      channelPlan: true,
    });
    expect(planForLookupKey('studio_channel_weekly')?.interval).toBe('week');
    expect(planForLookupKey('studio_channel_yearly')?.interval).toBe('year');
    // Legacy keys still resolve (old test-mode subscriptions until the ops migration).
    expect(planForLookupKey('studio_standard_yearly')).toEqual({
      tier: 'STANDARD',
      interval: 'year',
      channelPlan: false,
    });
    expect(planForLookupKey('studio_basic_monthly')?.tier).toBe('BASIC');
    expect(planForLookupKey('studio_enterprise_monthly')).toBeUndefined();
    expect(legacyLookupKeys()).toHaveLength(6);
  });

  it('sells only the three channel prices and the two HD packs', () => {
    const keys = allLookupKeys();
    expect(keys).toEqual([
      'studio_channel_weekly',
      'studio_channel_monthly',
      'studio_channel_yearly',
      'studio_pack_hd5',
      'studio_pack_hd15',
    ]);
    expect(Object.keys(REFERENCE_PRICES_PENCE).sort()).toEqual([...keys].sort());
    for (const key of legacyLookupKeys()) expect(keys).not.toContain(key);
  });

  it('only offers the trial on STANDARD; the trial has no long video', () => {
    expect(
      Object.values(PLAN_CATALOGUE)
        .filter((p) => p.trialDays > 0)
        .map((p) => p.tier),
    ).toEqual(['STANDARD']);
    expect(TRIAL).toMatchObject({ tier: 'STANDARD', shortVideos: 5, longVideos: 0 });
  });

  it('packs: 5 and 15 HD videos, any channel, valid 3 months; legacy packs still resolve', () => {
    expect(
      TOP_UP_PACKS.map((p) => [p.lookupKey, p.kind, p.quantity, p.validMonths, p.tier]),
    ).toEqual([
      ['studio_pack_hd5', 'short', 5, 3, 'STANDARD'],
      ['studio_pack_hd15', 'short', 15, 3, 'STANDARD'],
    ]);
    expect(sellableTopUpPack('studio_pack_hd15')?.quantity).toBe(15);
    expect(sellableTopUpPack('studio_topup_long2_plus')).toBeUndefined();
    expect(topUpPackForLookupKey('studio_topup_long2_plus')?.quantity).toBe(2);
    expect(LEGACY_TOP_UP_PACKS).toHaveLength(5);
    expect(topUpPackForLookupKey('nope')).toBeUndefined();
  });
});

describe('21.5 channel plan unit economics (internal)', () => {
  const at = (channels: number, interval: 'week' | 'month' | 'year') =>
    channelGrossMargin({ channels, interval });
  const typical = (channels: number, interval: 'week' | 'month' | 'year') =>
    channelGrossMargin({
      channels,
      interval,
      spendPence: channelTypicalSpendPence(channels, interval),
    });

  it('holds the 2026-10-04 reference prices', () => {
    expect(CATALOGUE_VERSION).toBe('2026-10-04');
    expect(REFERENCE_PRICES_PENCE).toEqual({
      studio_channel_weekly: 950,
      studio_channel_monthly: 2_900,
      studio_channel_yearly: 29_000,
      studio_pack_hd5: 1_500,
      studio_pack_hd15: 3_900,
    });
    expect(channelPlanMonthlyEquivalentPence(1, 'week')).toBeCloseTo(4_116.67, 1);
    expect(channelPlanMonthlyEquivalentPence(1, 'year')).toBeCloseTo(2_416.67, 1);
  });

  it('guard: every channel count and interval keeps ≥ 35 % at typical use (241p a short)', () => {
    for (const interval of ['week', 'month', 'year'] as const)
      for (let channels = 1; channels <= 6; channels += 1)
        expect(typical(channels, interval), `${channels} ${interval}`).toBeGreaterThanOrEqual(0.35);
    expect(typical(1, 'month')).toBeCloseTo(0.478, 2);
    expect(typical(1, 'week')).toBeCloseTo(0.584, 2);
    expect(typical(1, 'year')).toBeCloseTo(0.39, 2);
  });

  it('pins the margin at the internal cost cap (runbook §5: yearly and 1-channel monthly are negative at the cap)', () => {
    expect(at(1, 'month')).toBeCloseTo(-0.02, 2);
    expect(at(2, 'month')).toBeCloseTo(0.052, 2);
    expect(at(6, 'month')).toBeCloseTo(0.1, 2);
    expect(at(1, 'week')).toBeCloseTo(0.105, 2);
    expect(at(1, 'year')).toBeLessThan(0);
    // Weekly carries its 30 % premium: positive at the cap for every channel count.
    for (let channels = 1; channels <= 6; channels += 1)
      expect(at(channels, 'week')).toBeGreaterThan(0);
  });

  it('pins the pack margins when every credit spends its whole £2.50 headroom (runbook §5)', () => {
    const margins = TOP_UP_PACKS.map((pack) =>
      topUpMarginAtWorstCase(pack, REFERENCE_PRICES_PENCE[pack.lookupKey] ?? 0),
    );
    // The 15 pack (£39) is slightly below cost at the worst case: reported to the operator.
    expect(margins.map((m) => Math.round(m * 1000) / 1000)).toEqual([0.109, -0.011]);
  });

  it('every pack credit adds at least the STANDARD typical per-video cost to the cap', () => {
    for (const pack of TOP_UP_PACKS)
      expect(pack.capHeadroomPencePerCredit).toBeGreaterThanOrEqual(
        TYPICAL_COST_PENCE_PER_VIDEO.STANDARD.short,
      );
  });
});

describe('§P.2 legacy tier economics (2026-09-30 list, kept for ENTERPRISE and staff overrides)', () => {
  const margin = (key: string) => {
    const plan = planForLookupKey(key);
    if (!plan || plan.interval === 'week') throw new Error(key);
    return grossMarginAtCap({
      tier: plan.tier,
      interval: plan.interval,
      pricePence: LEGACY_REFERENCE_PRICES_PENCE[key] ?? 0,
    });
  };

  it('keeps the old monthly tier numbers for reference', () => {
    expect(lookupKeyFor('PLUS', 'year')).toBe('studio_plus_yearly');
    expect(margin('studio_basic_monthly')).toBeCloseTo(0.19, 3);
    expect(margin('studio_standard_monthly')).toBeCloseTo(0.1757, 3);
    expect(grossMarginTypical({ tier: 'BASIC', interval: 'month', pricePence: 2_900 })).toBeCloseTo(
      0.5693,
      3,
    );
    // STANDARD now at 241p a short (Seedance 2.0 full, 720p).
    expect(selfServeTiers().map((t) => fullAllowanceTypicalCostPence(t))).toEqual([
      1_800, 10_540, 26_400,
    ]);
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
