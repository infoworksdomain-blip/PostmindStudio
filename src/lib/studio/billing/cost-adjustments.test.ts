import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { effectiveOrgCaps } from '../cost/guard';
import { capAdjustmentFor } from './cost-adjustments';
import { trialStateFor, type EntitlementOverrides } from './entitlements';
import { createEntitlementsReader } from './entitlements-reader';

// §P.3 trial caps and 20.27: the trial's £10 a day / £15 total apply only while the trial runs;
// a staff override pauses them, ending the trial (Admin Centre) stops them for good.

const ORG = 'org-trial';
const at = new Date('2026-10-03T12:00:00Z');
const trial = trialStateFor(new Date('2026-10-01T09:00:00Z'), new Date('2026-10-15T09:00:00Z'));
const derived = { tier: 'STANDARD', access: 'full', source: 'trial', status: 'trialing' } as const;
const admin = {
  tier: 'PLUS' as const,
  reason: 'operator account',
  setByUserId: 'staff-1',
  setAt: at.toISOString(),
  expiresAt: null,
};

function deps(overrides: EntitlementOverrides) {
  const row = {
    organisationId: ORG,
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    graceUntil: null,
    overrides,
    everPaidAt: null,
  };
  const db = {
    orgEntitlement: { findUnique: async () => row },
    providerUsage: { aggregate: async () => ({ _sum: { costPence: 0 } }) },
    usageCreditUse: { findMany: async () => [] },
    usageCredit: { findMany: async () => [] },
  } as unknown as Pick<
    PrismaClient,
    'orgEntitlement' | 'providerUsage' | 'usageCreditUse' | 'usageCredit'
  >;
  return { db, entitlements: createEntitlementsReader({ db, ttlMs: 0, now: () => at.getTime() }) };
}

describe('capAdjustmentFor and the trial', () => {
  it('a running trial gets its daily and total caps', async () => {
    const { db, entitlements } = deps({ derived, trial });
    expect(await capAdjustmentFor(db, entitlements, ORG, at)).toEqual({
      monthlyHeadroomPence: 0,
      trial: { dailyPence: 1_000, monthlyPence: 1_500 },
    });
  });

  it('an active staff override has no trial caps', async () => {
    const { db, entitlements } = deps({ derived, trial, admin });
    expect((await capAdjustmentFor(db, entitlements, ORG, at))?.trial).toBeUndefined();
  });

  it('after staff end the trial there are no trial caps, with or without an override', async () => {
    const ended = { ...trial, endedAt: at.toISOString(), endedByUserId: 'staff-1' };
    for (const overrides of [
      { derived, trial: ended, admin },
      { derived, trial: ended },
    ]) {
      const { db, entitlements } = deps(overrides);
      expect((await capAdjustmentFor(db, entitlements, ORG, at))?.trial).toBeUndefined();
    }
  });
});

describe('21.5 channel plan caps (internal)', () => {
  it('a channel plan carries caps that scale with its channels', async () => {
    const { db, entitlements } = deps({
      derived: {
        tier: 'STANDARD',
        access: 'full',
        source: 'stripe',
        status: 'active',
        channels: 3,
        interval: 'month',
      },
    });
    expect(await capAdjustmentFor(db, entitlements, ORG, at)).toEqual({
      monthlyHeadroomPence: 0,
      plan: { dailyPence: 3_615, monthlyPence: 7_230 },
    });
  });

  it('effectiveOrgCaps: trial > staff cost-cap override > channel plan > tier default (+ pack headroom)', () => {
    const tierCaps = { dailyPence: 1_500, monthlyPence: 7_300 };
    const plan = { dailyPence: 1_205, monthlyPence: 2_410 };
    expect(effectiveOrgCaps(tierCaps, null, null)).toEqual(tierCaps);
    expect(effectiveOrgCaps(tierCaps, null, { monthlyHeadroomPence: 500, plan })).toEqual({
      dailyPence: 1_205,
      monthlyPence: 2_910,
    });
    expect(
      effectiveOrgCaps(
        tierCaps,
        { dailyPence: 9_000, monthlyPence: null },
        { monthlyHeadroomPence: 0, plan },
      ),
    ).toEqual({ dailyPence: 9_000, monthlyPence: 2_410 });
    expect(
      effectiveOrgCaps(
        tierCaps,
        { dailyPence: 9_000, monthlyPence: 9_000 },
        {
          monthlyHeadroomPence: 100,
          plan,
          trial: { dailyPence: 1_000, monthlyPence: 1_500 },
        },
      ),
    ).toEqual({ dailyPence: 1_000, monthlyPence: 1_500 });
    expect(
      effectiveOrgCaps({ dailyPence: undefined, monthlyPence: undefined }, null, null),
    ).toEqual({
      dailyPence: undefined,
      monthlyPence: undefined,
    });
  });
});
