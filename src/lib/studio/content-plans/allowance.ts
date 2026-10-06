import type { PrismaClient } from '@prisma/client';
import { limitInQuarters, planKindQuarters, quartersToVideos } from '../billing/allowance-units';
import { availableCreditQuarters, creditHeadroomPence } from '../billing/credits';
import { UGC_VIDEO_QUARTERS } from '../ugc/allowance';
import { capAdjustmentFor } from '../billing/cost-adjustments';
import {
  TOP_UP_PACKS,
  TYPICAL_COST_PENCE_PER_VIDEO,
  type SelfServeTier,
} from '../billing/catalogue';
import type { EntitlementsReader } from '../billing/entitlements-reader';
import { costCapsFromEnv, utcMonthKey, utcMonthRange, type CostCaps } from '../cost/caps';
import { effectiveOrgCaps } from '../cost/guard';
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
import type { FormatKey } from '../blitz/formats';
import type { PlanKind } from './mix';

// 20.9 — how many posts a month plan may generate: never more than the organisation's remaining
// monthly allowance (plan-quotas.ts, incl. unused top-up credits: a month plan's items are all
// short videos or slideshows, which count as short) and, at the typical cost per post, what fits
// under the monthly cost cap (cost/guard.ts caps, org overrides, top-up headroom, trial caps).
// When either cuts the month short, the draft says so (cappedReason) and the UI offers a top-up.
//
// DECISION: costs are estimates, per FORMAT (23.4). AI and UGC videos use the catalogue's typical
// cost per short video for the tier (billing/catalogue.ts TYPICAL_COST_PENCE_PER_VIDEO, ENTERPRISE
// as PLUS); the cheap formats use TYPICAL_FORMAT_COST_PENCE (measured on production). Month-plan
// items map their kind to a format (VIDEO → an AI video, SLIDESHOW → slideshow, CAROUSEL →
// carousel). "Up to" is every item's per-project budget cap (maxItemCostPence), a separate concept.

export interface PlanAllowance {
  mode: QuotaMode;
  /** Short videos this month: null limit = unlimited. */
  limit: number | null;
  /** Videos used (23.3: a quarter number, 5.5). */
  used: number;
  /** Pack videos left (a quarter number). */
  credits: number;
  /** Videos that may still be generated this month; null = no limit (warn mode or unlimited). */
  remaining: number | null;
  /** 23.3: the same in integer quarters of a video (a quick post 1, a video 4). */
  quarters: { limit: number | null; used: number; credits: number; remaining: number | null };
}

/** 23.3: one post a month plan or automation wants to make, and what it uses of the allowance. */
export interface CapItem {
  kind: PlanKind;
  /** Quarters of a video (ugc/allowance.ts: a quick post 1, a video 4, a UGC actor video 8). */
  quarters: number;
  /** 23.4: the format (automations), which sets the typical cost; month plans go by kind. */
  format?: FormatKey;
}

/**
 * 23.3: what a month-plan item of `kind` uses: a slideshow or carousel is a quick post (¼), a
 * video one video — two for a UGC actor video.
 */
export function planItemQuarters(kind: PlanKind, ugcActor = false): number {
  return kind === 'VIDEO' && ugcActor ? UGC_VIDEO_QUARTERS : planKindQuarters(kind);
}

/** Month-plan kinds as cap items (planItemQuarters). */
export function capItemsOf(kinds: readonly PlanKind[]): CapItem[] {
  return kinds.map((kind) => ({ kind, quarters: planItemQuarters(kind) }));
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

/**
 * 23.4 — typical provider cost of the cheap formats, rounded up from what they really cost on
 * production (provider_usage, 2026-10-04…06): carousel 3–4p, wall of text 8–15p, slideshow
 * 17–25p, hook + demo 41p. Before 23.4 every non-video post was priced at the slideshow budget
 * cap (150p) and a wall of text or hook + demo at a whole AI video (~241p), so a month of cheap
 * posts was cut short with "cost_cap" far below the real limit (production 2026-10-06: 84 slots
 * under a £100 cap with £36 spent). AI video (~180p measured) and UGC (144–209p) keep the
 * catalogue's typical cost per short video.
 */
export const TYPICAL_FORMAT_COST_PENCE: Readonly<
  Record<Exclude<FormatKey, 'ai_video' | 'ugc'>, number>
> = {
  carousel: 5,
  wall_of_text: 15,
  slideshow: 30,
  hook_demo: 50,
};

/** The format a month-plan item of `kind` is made as (hand-made month plans have no format). */
const KIND_FORMAT: Readonly<Record<PlanKind, FormatKey>> = {
  VIDEO: 'ai_video',
  SLIDESHOW: 'slideshow',
  CAROUSEL: 'carousel',
};

/** Typical provider cost of one post of `format` (see the DECISION above). */
export function typicalFormatCostPence(format: FormatKey, tier: PlanTier): number {
  if (format === 'ai_video' || format === 'ugc')
    return TYPICAL_COST_PENCE_PER_VIDEO[selfServe(tier)].short;
  return TYPICAL_FORMAT_COST_PENCE[format];
}

/** Typical provider cost of one post: its format's, else its kind's format (KIND_FORMAT). */
export function typicalItemCostPence(
  kind: PlanKind,
  tier: PlanTier,
  format?: FormatKey | null,
): number {
  return typicalFormatCostPence(format ?? KIND_FORMAT[kind], tier);
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

/**
 * Cap headroom one video-pack credit adds. 21.5: the HD packs work on any plan and channel, so
 * the smallest pack headroom is used whatever the tier (0 when nothing is for sale).
 */
export function creditHeadroomPerItem(_tier?: PlanTier): number {
  const headrooms = TOP_UP_PACKS.filter((p) => p.kind === 'short').map(
    (p) => p.capHeadroomPencePerCredit,
  );
  return headrooms.length ? Math.min(...headrooms) : 0;
}

/** How many leading items fit `quartersLeft` (null = no limit). */
function itemsWithin(items: readonly CapItem[], quartersLeft: number | null): number {
  if (quartersLeft === null) return items.length;
  let used = 0;
  let count = 0;
  for (const item of items) {
    if (used + item.quarters > quartersLeft) break;
    used += item.quarters;
    count += 1;
  }
  return count;
}

const quartersOf = (items: readonly CapItem[]) => items.reduce((n, i) => n + i.quarters, 0);

/**
 * How many of `items` (in slot order) the month can take, and why fewer when it cannot. 23.3:
 * counted in quarters of a video (a quick post uses ¼). Items past the plan allowance use top-up
 * credits first; each credit raises the cost cap by its headroom, so the cost check counts that
 * too. `quarters` is what the kept items use of the allowance.
 */
export function capItems(
  items: readonly CapItem[],
  tier: PlanTier,
  allowance: PlanAllowance,
  cost: PlanCost,
): { count: number; quarters: number; cappedReason: CappedReason | null } {
  const byAllowance = itemsWithin(items, allowance.quarters.remaining);
  if (cost.capPence === null)
    return {
      count: byAllowance,
      quarters: quartersOf(items.slice(0, byAllowance)),
      cappedReason: byAllowance < items.length ? 'allowance' : null,
    };
  const planLeft =
    allowance.quarters.limit === null
      ? Infinity
      : Math.max(0, allowance.quarters.limit - allowance.quarters.used);
  let spent = cost.spentPence;
  let cap = cost.capPence;
  let count = 0;
  let quarters = 0;
  for (const item of items.slice(0, byAllowance)) {
    // Items beyond the plan allowance spend a top-up credit, which raises this month's cap.
    if (allowance.mode === 'enforce' && quarters + item.quarters > planLeft)
      cap += cost.creditHeadroomPence;
    const next = spent + typicalItemCostPence(item.kind, tier, item.format);
    if (next > cap) break;
    spent = next;
    count += 1;
    quarters += item.quarters;
  }
  if (count < byAllowance) return { count, quarters, cappedReason: 'cost_cap' };
  return { count, quarters, cappedReason: count < items.length ? 'allowance' : null };
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
    availableCreditQuarters(deps.db, organisationId, at),
  ]);
  const quota = entitlementQuota(tierQuota(tier, env), entitlements);
  const mode = quotaMode(env, entitlements ? 'enforce' : 'warn');
  // 23.3: counted in quarters of a video; the video fields are for display.
  const usedQ = usage.videos.short.usedQuarters;
  const limit = quota.shortVideos;
  const limitQ = limitInQuarters(limit);
  const remainingQ =
    mode === 'warn' || limitQ === null ? null : Math.max(0, limitQ - usedQ) + credits.short;
  const caps = deps.caps ?? costCapsFromEnv(env);
  const override = await deps.db.orgCostCap.findUnique({ where: { organisationId } });
  const adjustment = deps.entitlements
    ? await capAdjustmentFor(deps.db, deps.entitlements, organisationId, at)
    : null;
  // Without billing entitlements (core mode) top-up headroom is still counted.
  const headroom = deps.entitlements
    ? (adjustment?.monthlyHeadroomPence ?? 0)
    : await creditHeadroomPence(deps.db, organisationId, utcMonthKey(at));
  const capPence =
    effectiveOrgCaps(
      {
        dailyPence: undefined,
        monthlyPence: resolveOrgCap('monthly', caps, tier, null).pence,
      },
      override,
      adjustment
        ? { ...adjustment, monthlyHeadroomPence: headroom }
        : { monthlyHeadroomPence: headroom },
    ).monthlyPence ?? null;
  const { start, end } = utcMonthRange(at);
  const spent = await deps.db.providerUsage.aggregate({
    where: { organisationId, day: { gte: start, lt: end } },
    _sum: { costPence: true },
  });
  return {
    allowance: {
      mode,
      limit,
      used: quartersToVideos(usedQ),
      credits: quartersToVideos(credits.short),
      remaining: remainingQ === null ? null : quartersToVideos(remainingQ),
      quarters: { limit: limitQ, used: usedQ, credits: credits.short, remaining: remainingQ },
    },
    cost: {
      capPence,
      spentPence: spent._sum.costPence ?? 0,
      creditHeadroomPence: creditHeadroomPerItem(tier),
    },
  };
}
