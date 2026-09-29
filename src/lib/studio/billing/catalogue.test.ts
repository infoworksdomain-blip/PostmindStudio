import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_DAILY_CAP_PENCE, DEFAULT_ORG_MONTHLY_CAP_PENCE } from '../cost/caps';
import { DEFAULT_TIER_QUOTAS } from '../services/plan-quotas';
import { PLAN_CATALOGUE, planForLookupKey, TOP_UP_PACKS, topUpPackForLookupKey } from './catalogue';
import { createStubEntitlementsReader, NO_PLAN_ENTITLEMENTS } from './entitlements-reader';

describe('PLAN_CATALOGUE (Phase 18 §P.1)', () => {
  it('holds today’s quota and cost-cap numbers unchanged', () => {
    for (const plan of Object.values(PLAN_CATALOGUE)) {
      const q = DEFAULT_TIER_QUOTAS[plan.tier];
      expect(plan.shortVideosPerMonth, plan.tier).toBe(q.shortVideos);
      expect(plan.longVideosPerMonth, plan.tier).toBe(q.longVideos);
      expect(plan.shortMaxSec, plan.tier).toBe(q.shortMaxSec);
      expect(plan.longMaxSec, plan.tier).toBe(q.longMaxSec);
      expect(plan.platforms, plan.tier).toBe(q.platforms);
      expect(plan.dailyCostCapPence, plan.tier).toBe(DEFAULT_ORG_DAILY_CAP_PENCE[plan.tier]);
      expect(plan.monthlyCostCapPence, plan.tier).toBe(DEFAULT_ORG_MONTHLY_CAP_PENCE[plan.tier]);
    }
  });

  it('maps every self-serve lookup key back to its tier and interval', () => {
    expect(planForLookupKey('studio_standard_yearly')).toEqual({
      tier: 'STANDARD',
      interval: 'year',
    });
    expect(planForLookupKey('studio_basic_monthly')).toEqual({ tier: 'BASIC', interval: 'month' });
    expect(planForLookupKey('studio_enterprise_monthly')).toBeUndefined();
    const keys = Object.values(PLAN_CATALOGUE).flatMap((p) => Object.values(p.lookupKeys));
    expect(new Set(keys).size).toBe(keys.length);
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

describe('createStubEntitlementsReader', () => {
  it('answers "no plan" until Track C lands', async () => {
    const reader = createStubEntitlementsReader();
    await expect(reader.forOrganisation('org-1')).resolves.toBe(NO_PLAN_ENTITLEMENTS);
    expect(() => reader.invalidate('org-1')).not.toThrow();
    expect(NO_PLAN_ENTITLEMENTS.access).toBe('none');
  });
});
