import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { UnprocessableError, ValidationError } from '../../errors';
import { planCandidates, type PlanTier } from '../providers/router';

// 15.C4 — per-generation overrides (spec 8.2: "Body may override brief, tier, providers";
// 14.1 Advanced options "provider tier override").
//   - qualityTier may only go DOWN from the organisation's plan: a cheaper tier routes to the
//     cheaper candidate lists (spec 6.4). Above the plan → 422.
//   - preferredProviders per visual treatment reorders that treatment's candidates. Every id
//     must be a candidate for the treatment on the effective tier (unknown → 400); the router
//     still applies its usual checks (configured, kill switch, budget, breaker), so a preference
//     never forces a provider that is down or over budget.
// The overrides are stored in the run's metadata (generation) and read by generate-asset.

export const PLAN_TIERS = ['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const;
const TIER_RANK: Record<PlanTier, number> = { BASIC: 0, STANDARD: 1, PLUS: 2, ENTERPRISE: 3 };

/** Treatments routed to a generation provider (the others are built by the composer). */
export const ROUTED_TREATMENTS = ['AI_CLIP', 'AI_AVATAR', 'STOCK_FOOTAGE', 'IMAGE_STILL'] as const;
export type RoutedTreatment = (typeof ROUTED_TREATMENTS)[number];

const providerId = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,40}$/, 'Provider ids are lower-case letters, digits and hyphens');

export const generateOverridesInput = {
  qualityTier: z.enum(PLAN_TIERS).optional(),
  preferredProviders: z
    .partialRecord(z.enum(ROUTED_TREATMENTS), z.array(providerId).min(1).max(5))
    .optional(),
};

export interface GenerateOverrides {
  qualityTier?: PlanTier;
  preferredProviders?: Partial<Record<RoutedTreatment, string[]>>;
}

/** The tier this run uses: the requested one, never above the organisation's plan. */
export function effectiveTier(planTier: PlanTier, requested: PlanTier | undefined): PlanTier {
  if (!requested) return planTier;
  if (TIER_RANK[requested] > TIER_RANK[planTier]) {
    throw new UnprocessableError(
      `qualityTier ${requested} is above the organisation's ${planTier} plan`,
      { planTier, requestedTier: requested },
    );
  }
  return requested;
}

/** Every preferred provider must be a candidate for its treatment on the effective tier. */
export function validatePreferredProviders(
  preferred: GenerateOverrides['preferredProviders'],
  tier: PlanTier,
): Partial<Record<RoutedTreatment, string[]>> | undefined {
  if (!preferred) return undefined;
  const out: Partial<Record<RoutedTreatment, string[]>> = {};
  for (const treatment of ROUTED_TREATMENTS) {
    const ids = preferred[treatment];
    if (!ids) continue;
    // AI_AVATAR with a custom brand avatar narrows to HeyGen; the general list is the superset.
    const allowed = planCandidates(
      { kind: 'shot', visualTreatment: treatment, durationSec: 5 },
      tier,
    ).providerIds;
    const unknown = ids.filter((id) => !allowed.includes(id));
    if (unknown.length > 0) {
      throw new ValidationError(
        `Unknown ${treatment} provider(s) for the ${tier} tier: ${unknown.join(', ')}`,
        { treatment, unknown, allowed },
      );
    }
    out[treatment] = [...new Set(ids)];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The run's preferred providers for a shot treatment (metadata.preferredProviders). */
export function runPreferredProviders(
  metadata: Prisma.JsonValue | null,
  treatment: string,
): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const map = (metadata as Record<string, unknown>).preferredProviders;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const ids = (map as Record<string, unknown>)[treatment];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}
