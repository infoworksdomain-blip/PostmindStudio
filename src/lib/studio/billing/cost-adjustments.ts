import type { PrismaClient } from '@prisma/client';
import { utcMonthKey, utcMonthRange } from '../cost/caps';
import type { CapAdjustment, CapAdjustmentLookup } from '../cost/guard';
import { planCostCapsPence } from './plans';
import { creditHeadroomPence } from './credits';
import type { EntitlementsReader } from './entitlements-reader';

// Phase 18 §P.3 — what billing changes about the spec 12.5 cost caps (cost/guard.ts):
//   - top-up headroom: each credit consumed this month raises the monthly cap by its pack's
//     worst-case allowance (catalogue capHeadroomPencePerCredit), so paid credits are never
//     stopped by the cap they paid for;
//   - trial: £10 a day and £15 for the WHOLE trial (§P.1). The trial can span two calendar
//     months, so the monthly cap during a trial is £15 minus what the trial already spent in
//     earlier months;
//   - 26.1 plans: daily and monthly caps sized to the plan's allowance (its videos a month ×
//     ~£2.41 a video + 25 % headroom, plans.ts), replacing the STANDARD tier default.

type AdjustmentDb = Pick<PrismaClient, 'usageCreditUse' | 'usageCredit' | 'providerUsage'>;

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export async function capAdjustmentFor(
  db: AdjustmentDb,
  entitlements: EntitlementsReader,
  organisationId: string,
  at: Date,
): Promise<CapAdjustment | null> {
  const ent = await entitlements.forOrganisation(organisationId);
  if (ent.trial) {
    const started = utcDay(new Date(ent.trial.startedAt));
    const { start: monthStart } = utcMonthRange(at);
    let spentBefore = 0;
    if (started < monthStart) {
      const sum = await db.providerUsage.aggregate({
        where: { organisationId, day: { gte: started, lt: monthStart } },
        _sum: { costPence: true },
      });
      spentBefore = sum._sum.costPence ?? 0;
    }
    return {
      monthlyHeadroomPence: 0,
      trial: {
        dailyPence: ent.trial.dailyCostCapPence,
        monthlyPence: Math.max(0, ent.trial.totalCostCapPence - spentBefore),
      },
    };
  }
  const headroom = await creditHeadroomPence(db, organisationId, utcMonthKey(at));
  // 26.1: a plan's caps scale with its videos (internal; never shown to customers).
  const plan = ent.plan ? planCostCapsPence(ent.plan.id, ent.plan.interval) : undefined;
  if (headroom === 0 && !plan) return null;
  return { monthlyHeadroomPence: headroom, ...(plan && { plan }) };
}

/**
 * Not cached on purpose: a credit consumed by the web process must raise the cap the worker sees
 * on its very next provider call. Both queries use indexes (usage_credit_uses(org, month),
 * provider_usage(org, day)); entitlements come from the reader's own 30 s cache.
 */
export function createCapAdjustmentLookup(options: {
  db: AdjustmentDb;
  entitlements: EntitlementsReader;
}): CapAdjustmentLookup {
  return (organisationId, at) =>
    capAdjustmentFor(options.db, options.entitlements, organisationId, at);
}
