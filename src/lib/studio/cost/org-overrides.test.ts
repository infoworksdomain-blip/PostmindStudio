import { describe, expect, it, vi } from 'vitest';
import { costCapsFromEnv } from './caps';
import {
  createOrgCapOverrideLookup,
  OVERRIDE_CACHE_TTL_MS,
  resolveOrgCap,
  resolveOrgCapByTier,
} from './org-overrides';
import { orgCostCapsInput, viewOrgCostCaps } from '../services/org-cost-caps';

// BACKLOG 13.19 — cap resolution order: organisation override > env > default.

const caps = costCapsFromEnv({
  STUDIO_ORG_DAILY_CAP_PENCE_PLUS: '9000',
  STUDIO_ORG_MONTHLY_CAP_PENCE_ENTERPRISE: 'none',
});

describe('resolveOrgCap', () => {
  it('override > env > default', () => {
    expect(
      resolveOrgCap('daily', caps, 'STANDARD', { dailyPence: 20_000, monthlyPence: null }),
    ).toEqual({
      pence: 20_000,
      source: 'org_override',
    });
    expect(resolveOrgCap('daily', caps, 'PLUS', null)).toEqual({ pence: 9_000, source: 'env' });
    expect(resolveOrgCap('daily', caps, 'STANDARD', null)).toEqual({
      pence: 3_000,
      source: 'default',
    });
    // A null column is "no override" for that period only.
    expect(
      resolveOrgCap('monthly', caps, 'STANDARD', { dailyPence: 20_000, monthlyPence: null }),
    ).toEqual({ pence: 15_000, source: 'default' });
    expect(resolveOrgCap('monthly', caps, 'ENTERPRISE', null)).toEqual({
      pence: undefined,
      source: 'disabled',
    });
    // An override even replaces a cap disabled by env.
    expect(
      resolveOrgCap('monthly', caps, 'ENTERPRISE', { dailyPence: null, monthlyPence: 500_000 }),
    ).toEqual({ pence: 500_000, source: 'org_override' });
  });

  it('lists every tier for admin views', () => {
    expect(resolveOrgCapByTier('daily', caps, null)).toEqual({
      BASIC: { pence: 1_000, source: 'default' },
      STANDARD: { pence: 3_000, source: 'default' },
      PLUS: { pence: 9_000, source: 'env' },
      ENTERPRISE: { pence: 40_000, source: 'default' },
    });
  });
});

describe('createOrgCapOverrideLookup', () => {
  it('caches per organisation for 30 s', async () => {
    let t = 0;
    const findUnique = vi.fn(async () => ({
      organisationId: 'org-1',
      dailyPence: 100,
      monthlyPence: null,
      reason: 'x',
      updatedByUserId: 'u',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const lookup = createOrgCapOverrideLookup({ orgCostCap: { findUnique } } as never, {
      now: () => t,
    });
    expect(await lookup('org-1')).toEqual({ dailyPence: 100, monthlyPence: null });
    await lookup('org-1');
    expect(findUnique).toHaveBeenCalledTimes(1);
    t += OVERRIDE_CACHE_TTL_MS;
    await lookup('org-1');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('returns null for an organisation without overrides', async () => {
    const lookup = createOrgCapOverrideLookup({
      orgCostCap: { findUnique: vi.fn(async () => null) },
    } as never);
    expect(await lookup('org-2')).toBeNull();
  });
});

describe('org cost caps service shapes', () => {
  it('validates input: a reason is required, null clears, pounds-as-pence typos are refused', () => {
    expect(orgCostCapsInput.safeParse({ dailyPence: 20_000 }).success).toBe(false);
    expect(orgCostCapsInput.safeParse({ reason: 'Pilot' }).success).toBe(false);
    expect(orgCostCapsInput.safeParse({ dailyPence: null, reason: 'Back to plan' }).success).toBe(
      true,
    );
    expect(orgCostCapsInput.safeParse({ dailyPence: 0, reason: 'x y z' }).success).toBe(false);
    expect(
      orgCostCapsInput.safeParse({ monthlyPence: 20_000_000, reason: 'too big' }).success,
    ).toBe(false);
  });

  it('views an override as org_override and no row as plan_tier', () => {
    const now = new Date();
    const withRow = viewOrgCostCaps(
      'org-1',
      {
        organisationId: 'org-1',
        dailyPence: 20_000,
        monthlyPence: null,
        reason: 'Pilot, agreed with Commercial',
        updatedByUserId: 'staff',
        createdAt: now,
        updatedAt: now,
      },
      caps,
    );
    expect(withRow.caps.daily).toMatchObject({ pence: 20_000, source: 'org_override' });
    expect(withRow.caps.monthly).toMatchObject({ pence: null, source: 'plan_tier' });
    expect(withRow.caps.monthly.byTier.STANDARD).toEqual({ pence: 15_000, source: 'default' });
    expect(viewOrgCostCaps('org-2', null, caps)).toMatchObject({
      override: null,
      caps: { daily: { source: 'plan_tier' } },
    });
  });
});
