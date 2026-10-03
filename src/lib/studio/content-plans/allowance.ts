import type { PrismaClient } from '@prisma/client';
import { availableCredits, creditHeadroomPence } from '../billing/credits';
import { capAdjustmentFor } from '../billing/cost-adjustments';
import {
  TOP_UP_PACKS,
  TYPICAL_COST_PENCE_PER_VIDEO,
  type SelfServeTier,
} from '../billing/catalogue';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { costCapsFromEnv, utcMonthKey, utcMonthRange, type CostCaps } from '../cost/caps';
import { resolveOrgCap } from '../cost/org-overrides';
import { DEFAULT_SLIDESHOW_BUDGET_PENCE, shortFormBudgetPence } from '../cost/project-budget';
import type { PlanTier } from '../providers/router';
import {
  entitlementQuota,
  quotaMode,
  tierQuota,
  usageView,
  type QuotaMode,
} from '../services/plan-quotas';
import type { PlanKind } from './mix';

// 20.9 — how many posts a month plan may generate: never more than the organisation's remaining
// monthly allowance (plan-quotas.ts, incl. unused top-up credits: a month plan's items are all
// short videos or slideshows, which count as short) and, at the typical cost per post, what fits
// under the monthly cost cap (cost/guard.ts caps, org overrides, top-up headroom, trial caps).
// When either cuts the month short, the draft says so (cappedReason) and the UI offers a top-up.
//
// DECISION: costs are estimates. Videos use the catalogue's typical cost per short video for the
// tier (billing/catalogue.ts TYPICAL_COST_PENCE_PER_VIDEO, ENTERPRISE as PLUS); slideshows have no
// catalogued typical cost, so their per-project cap (DEFAULT_SLIDESHOW_BUDGET_PENCE) is used,
// which overstates them. "Up to" is every item's per-project budget cap.

export interface PlanAllowance {
  mode: QuotaMode;
  /** Short videos this month: null limit = unlimited. */
  limit: number | null;
  used: number;
  credits: number;
  /** What may still be generated this month; null = no limit (warn mode or unlimited plan). */
  remaining: number | null;
}

export interface PlanCost {
  /** Monthly cost cap incl. top-up headroom already earned; null = no cap. */
  capPence: number | null;
  spentPence: number;
  /** Headroom each top-up credit spent by this plan adds to the cap. */
  creditHeadroomPence: number;
}

export type CappedReason = 'allowance' | 'cost_cap';

const selfServe = (tier: PlanTier): SelfServeTier => (tier === 'ENTERPRISE' ? 'PLUS' : tier);

/** Typical provider cost of one post (see the DECISION above). */
export function typicalItemCostPence(kind: PlanKind, tier: PlanTier): number {
  const video = TYPICAL_COST_PENCE_PER_VIDEO[selfServe(tier)].short;
  return kind === 'VIDEO' ? video : DEFAULT_SLIDESHOW_BUDGET_PENCE;
}

/** The per-project budget cap of one post (the most it can cost before it pauses). */
export function maxItemCostPence(kind: PlanKind, tier?: PlanTier): number {
  return kind === 'VIDEO' ? shortFormBudgetPence(tier) : DEFAULT_SLIDESHOW_BUDGET_PENCE;
}

export function estimateCost(kinds: PlanKind[], tier: PlanTier) {
  return {
    typicalPence: kinds.reduce((sum, k) => sum + typicalItemCostPence(k, tier), 0),
    maxPence: kinds.reduce((sum, k) => sum + maxItemCostPence(k, tier), 0),
  };
}

/** Cap headroom one top-up credit of the tier's short pack adds (0 when there is no pack). */
export function creditHeadroomPerItem(tier: PlanTier): number {
  const pack = TOP_UP_PACKS.find((p) => p.tier === selfServe(tier) && p.kind === 'short');
  return pack?.capHeadroomPencePerCredit ?? 0;
}

/**
 * How many of `kinds` (in slot order) the month can take, and why fewer when it cannot. Items
 * past the plan allowance use top-up credits first; each credit raises the cost cap by its
 * headroom, so the cost check counts that too.
 */
export function capItems(
  kinds: PlanKind[],
  tier: PlanTier,
  allowance: PlanAllowance,
  cost: PlanCost,
): { count: number; cappedReason: CappedReason | null } {
  const byAllowance =
    allowance.remaining === null ? kinds.length : Math.min(kinds.length, allowance.remaining);
  if (cost.capPence === null)
    return {
      count: byAllowance,
      cappedReason: byAllowance < kinds.length ? 'allowance' : null,
    };
  const planLeft =
    allowance.limit === null ? Infinity : Math.max(0, allowance.limit - allowance.used);
  let spent = cost.spentPence;
  let cap = cost.capPence;
  let count = 0;
  for (const [i, kind] of kinds.slice(0, byAllowance).entries()) {
    // Items beyond the plan allowance spend a top-up credit, which raises this month's cap.
    if (allowance.mode === 'enforce' && i >= planLeft) cap += cost.creditHeadroomPence;
    const next = spent + typicalItemCostPence(kind, tier);
    if (next > cap) break;
    spent = next;
    count += 1;
  }
  if (count < byAllowance) return { count, cappedReason: 'cost_cap' };
  return { count, cappedReason: count < kinds.length ? 'allowance' : null };
}

type AllowanceDb = Pick<
  PrismaClient,
  | 'videoProject'
  | 'websiteScan'
  | 'imageLibraryItem'
  | 'usageCredit'
  | 'usageCreditUse'
  | 'providerUsage'
  | 'orgCostCap'
>;

/** The organisation's allowance and monthly cost headroom right now. */
export async function loadPlanAllowance(
  deps: {
    db: AllowanceDb;
    now: () => number;
    env?: Record<string, string | undefined>;
    entitlements?: EntitlementsReader;
    caps?: CostCaps;
  },
  organisationId: string,
  tier: PlanTier,
): Promise<{ allowance: PlanAllowance; cost: PlanCost }> {
  const env = deps.env ?? process.env;
  const at = new Date(deps.now());
  const entitlements = deps.entitlements
    ? await deps.entitlements.forOrganisation(organisationId)
    : undefined;
  const [usage, credits] = await Promise.all([
    usageView(deps, organisationId, tier, undefined, entitlements),
    availableCredits(deps.db, organisationId, at),
  ]);
  const quota = entitlementQuota(tierQuota(tier, env), entitlements);
  const mode = quotaMode(env, entitlements ? 'enforce' : 'warn');
  const used = usage.videos.short.used;
  const limit = quota.shortVideos;
  const remaining =
    mode === 'warn' || limit === null ? null : Math.max(0, limit - used) + credits.short;
  const caps = deps.caps ?? costCapsFromEnv(env);
  const override = await deps.db.orgCostCap.findUnique({ where: { organisationId } });
  const adjustment =
    deps.entitlements && (await capAdjustmentFor(deps.db, deps.entitlements, organisationId, at));
  const base = resolveOrgCap('monthly', caps, tier, override).pence;
  const headroom = adjustment
    ? adjustment.monthlyHeadroomPence
    : await creditHeadroomPence(deps.db, organisationId, utcMonthKey(at));
  const capPence =
    adjustment && adjustment.trial
      ? adjustment.trial.monthlyPence
      : base === undefined
        ? null
        : base + headroom;
  const { start, end } = utcMonthRange(at);
  const spent = await deps.db.providerUsage.aggregate({
    where: { organisationId, day: { gte: start, lt: end } },
    _sum: { costPence: true },
  });
  return {
    allowance: { mode, limit, used, credits: credits.short, remaining },
    cost: {
      capPence,
      spentPence: spent._sum.costPence ?? 0,
      creditHeadroomPence: creditHeadroomPerItem(tier),
    },
  };
}
