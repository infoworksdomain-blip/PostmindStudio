import type { OrgCostCap, PrismaClient } from '@prisma/client';
import type { PlanTier } from '../providers/router';
import { PLAN_TIERS, type CapSource, type CostCaps } from './caps';

// BACKLOG 13.19 — per-organisation cost cap overrides (studio.org_cost_caps), set by PostMind
// staff with a reason (PUT /admin/organisations/:id/cost-caps). Resolution order for the
// organisation daily and monthly caps:
//   1. the organisation's override (source "org_override"), when set;
//   2. STUDIO_ORG_{DAILY,MONTHLY}_CAP_PENCE_<TIER> (source "env", or "disabled");
//   3. the operator-decision default for the plan tier (source "default").
// An override is always a positive cap: it can raise or lower a limit, never remove it. The
// global daily cap and the per-provider cap are platform-wide and have no override.

export interface OrgCapOverride {
  dailyPence: number | null;
  monthlyPence: number | null;
}

export type OrgCapSource = CapSource | 'org_override';

export interface ResolvedCap {
  pence: number | undefined;
  source: OrgCapSource;
}

/** The effective daily or monthly cap of one organisation at one plan tier. */
export function resolveOrgCap(
  kind: 'daily' | 'monthly',
  caps: CostCaps,
  tier: PlanTier,
  override: OrgCapOverride | null | undefined,
): ResolvedCap {
  const own = kind === 'daily' ? override?.dailyPence : override?.monthlyPence;
  if (own != null) return { pence: own, source: 'org_override' };
  const byTier = kind === 'daily' ? caps.orgDailyPenceByTier : caps.orgMonthlyPenceByTier;
  const sources = kind === 'daily' ? caps.sources?.orgDailyByTier : caps.sources?.orgMonthlyByTier;
  const pence = byTier?.[tier];
  return { pence, source: sources?.[tier] ?? (pence === undefined ? 'disabled' : 'env') };
}

/** Every tier's value, for an organisation whose tier Studio does not store (admin views). */
export function resolveOrgCapByTier(
  kind: 'daily' | 'monthly',
  caps: CostCaps,
  override: OrgCapOverride | null | undefined,
): Record<PlanTier, { pence: number | null; source: OrgCapSource }> {
  return Object.fromEntries(
    PLAN_TIERS.map((tier) => {
      const cap = resolveOrgCap(kind, caps, tier, override);
      return [tier, { pence: cap.pence ?? null, source: cap.source }];
    }),
  ) as Record<PlanTier, { pence: number | null; source: OrgCapSource }>;
}

export type OrgCapOverrideLookup = (organisationId: string) => Promise<OrgCapOverride | null>;

export const OVERRIDE_CACHE_TTL_MS = 30_000;

/**
 * Cached reader for the cost guard, which runs before every provider call: one row per
 * organisation, cached for 30 s (like the kill-switch flags), so a staff change applies within
 * half a minute on every worker.
 */
export function createOrgCapOverrideLookup(
  db: Pick<PrismaClient, 'orgCostCap'>,
  options: { ttlMs?: number; now?: () => number } = {},
): OrgCapOverrideLookup {
  const ttlMs = options.ttlMs ?? OVERRIDE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: OrgCapOverride | null; at: number }>();
  return async (organisationId) => {
    const hit = cache.get(organisationId);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const row: OrgCostCap | null = await db.orgCostCap.findUnique({ where: { organisationId } });
    const value = row ? { dailyPence: row.dailyPence, monthlyPence: row.monthlyPence } : null;
    if (cache.size > 10_000) cache.clear();
    cache.set(organisationId, { value, at: now() });
    return value;
  };
}
