import type { PrismaClient } from '@prisma/client';
import { PlanTierError, QuotaExceededError } from '../../errors';
import { logger } from '../../logger';
import type { TenantContext } from '../../tenant';
import type { PlanTier } from '../providers/router';
import {
  minTierFor,
  minTierForImageLibrary,
  PLAN_CATALOGUE,
  TIER_ORDER as CATALOGUE_TIER_ORDER,
  tierAtLeast as catalogueTierAtLeast,
} from '../billing/catalogue';
import { toPlanTier } from './catalog';

// BACKLOG 15.D2 — Addendum A10.3 "Tier gating for v1.1 features" and A10.4 "Cost cap changes".
// One table of gates; the services enforce them (403 `plan_tier` with details.requiredTier):
//
//   A10.3 row                                   Basic      Standard   Plus       Enterprise
//   "Library — INSPIRE mode"                    -          ✓          ✓          ✓
//   "Library — TEMPLATE mode"                   -          -          ✓          ✓
//   "Save custom overlay presets"               -          ✓          ✓          ✓
//   "Save custom slideshow templates"           -          ✓          ✓          ✓
//   "Auto-image library"  "Stock only" / "Stock + site scrape" / "All 3 layers" / "All 3 + BYOC
//                          image gen"  → on-demand generation (Layer 3) is Plus and above
//   "Website scan (Feature D)"  "1 business" / "3 businesses" / "10 businesses" / "Unlimited"
//
// A10.4 caps: "Feature D scan: single scan hard-capped at £0.50" (cost/scan-budget.ts) and
// "Image library generation: per-business monthly cap on DALL-E image count — Basic 20, Standard
// 50, Plus 200, Enterprise 1000." The count is image_library rows with source GENERATED created in
// the calendar month (UTC) for the business — on-demand, slideshow and IMAGE_STILL generations
// alike — so no counter table is needed. A deleted generated image no longer counts (documented).

// Phase 18 §P.3: tier order, minimum tiers and limits come from the plan catalogue
// (billing/catalogue.ts); env overrides keep precedence where they exist.
export const TIER_ORDER: readonly PlanTier[] = CATALOGUE_TIER_ORDER;

const TIER_LABEL: Record<PlanTier, string> = {
  BASIC: 'Basic',
  STANDARD: 'Standard',
  PLUS: 'Plus',
  ENTERPRISE: 'Enterprise',
};

export function tierLabel(tier: PlanTier): string {
  return TIER_LABEL[tier];
}

export function tierAtLeast(tier: PlanTier, minTier: PlanTier): boolean {
  return catalogueTierAtLeast(tier, minTier);
}

export interface TierGateDefinition {
  minTier: PlanTier;
  /** What the user tried to do, for the 403 message. */
  label: string;
  /** The A10.3 row the gate implements. */
  spec: string;
}

export const TIER_GATES = {
  'library.inspire': {
    minTier: minTierFor('libraryInspire'),
    label: 'Library INSPIRE mode',
    spec: 'A10.3 "Library — INSPIRE mode": - / ✓ / ✓ / ✓',
  },
  'library.template': {
    minTier: minTierFor('libraryTemplate'),
    label: 'Library TEMPLATE mode',
    spec: 'A10.3 "Library — TEMPLATE mode": - / - / ✓ / ✓',
  },
  'overlays.custom_presets': {
    minTier: minTierFor('customPresets'),
    label: 'Saving custom overlay presets',
    spec: 'A10.3 "Save custom overlay presets": - / ✓ / ✓ / ✓',
  },
  'slideshow.custom_templates': {
    minTier: minTierFor('customPresets'),
    label: 'Saving custom slideshow templates',
    spec: 'A10.3 "Save custom slideshow templates": - / ✓ / ✓ / ✓',
  },
  'image_library.generate': {
    minTier: minTierForImageLibrary('ai_generation'),
    label: 'Generating images for the image library',
    spec: 'A10.3 "Auto-image library": Stock only / Stock + site scrape / All 3 layers / All 3 + BYOC image gen',
  },
  'approval.workflows': {
    minTier: minTierFor('approvalWorkflows'),
    label: 'Multi-step approval workflows',
    spec: 'Phase 18 §P.1 "Approval workflows (multi-step)": single approve / ✓ / ✓ / ✓',
  },
} as const satisfies Record<string, TierGateDefinition>;

export type TierGate = keyof typeof TIER_GATES;

type TenantTier = Pick<TenantContext, 'organisation'>;

export function planTierOf(tenant: TenantTier): PlanTier {
  return toPlanTier(tenant.organisation.planTier);
}

/** Throws 403 plan_tier (details.requiredTier) when the tenant's plan is below the gate. */
export function assertTierGate(tenant: TenantTier, gate: TierGate): void {
  const tier = planTierOf(tenant);
  const { minTier, label } = TIER_GATES[gate];
  if (tierAtLeast(tier, minTier)) return;
  throw new PlanTierError(
    minTier,
    `${label} is available on the ${tierLabel(minTier)} plan and above; upgrade to use it`,
    { gate, planTier: tier },
  );
}

// ------------------------------------------------------------------ calendar month (UTC)

export interface MonthWindow {
  /** "YYYY-MM" */
  key: string;
  start: Date;
  /** Exclusive: the first instant of the next month (when the quota resets). */
  end: Date;
}

export function monthWindow(now: number): MonthWindow {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start, end };
}

// ------------------------------------------------------------------ website scans

/** A10.3 "Website scan (Feature D)": businesses an organisation may scan (null = unlimited). */
export const SCANNED_BUSINESS_LIMITS: Readonly<Record<PlanTier, number | null>> = Object.freeze(
  Object.fromEntries(TIER_ORDER.map((t) => [t, PLAN_CATALOGUE[t].scanBusinesses])) as Record<
    PlanTier,
    number | null
  >,
);

/** The lowest tier whose limit admits `count + 1` businesses. */
function tierForBusinessCount(count: number): PlanTier {
  return (
    TIER_ORDER.find((t) => {
      const limit = SCANNED_BUSINESS_LIMITS[t];
      return limit === null || limit > count;
    }) ?? 'ENTERPRISE'
  );
}

/** Distinct businesses of the organisation with at least one scan (any state). */
export async function scannedBusinessCount(
  db: Pick<PrismaClient, 'websiteScan'>,
  organisationId: string,
): Promise<number> {
  const rows = await db.websiteScan.findMany({
    where: { organisationId },
    distinct: ['businessId'],
    select: { businessId: true },
  });
  return rows.length;
}

/**
 * A business already scanned may always be rescanned; a new one needs room in the tier's limit.
 */
export async function assertScanBusinessAllowed(
  db: Pick<PrismaClient, 'websiteScan'>,
  tenant: TenantTier & { organisationId: string },
  businessId: string,
): Promise<void> {
  const tier = planTierOf(tenant);
  const limit = SCANNED_BUSINESS_LIMITS[tier];
  if (limit === null) return;
  const scanned = await db.websiteScan.findFirst({
    where: { organisationId: tenant.organisationId, businessId },
    select: { id: true },
  });
  if (scanned) return;
  const count = await scannedBusinessCount(db, tenant.organisationId);
  if (count < limit) return;
  const requiredTier = tierForBusinessCount(count);
  throw new PlanTierError(
    requiredTier,
    `Your ${tierLabel(tier)} plan includes website scans for ${limit} ${
      limit === 1 ? 'business' : 'businesses'
    }; upgrade to ${tierLabel(requiredTier)} to scan another`,
    { gate: 'scan.businesses', planTier: tier, limit, scannedBusinesses: count },
  );
}

// ------------------------------------------------------------------ image generation cap

/** A10.4 "Basic 20, Standard 50, Plus 200, Enterprise 1000" generated images per business/month. */
export const DEFAULT_IMAGE_GENERATION_MONTHLY_CAP: Readonly<Record<PlanTier, number>> =
  Object.freeze(
    Object.fromEntries(
      TIER_ORDER.map((t) => [t, PLAN_CATALOGUE[t].generatedImagesPerBusinessPerMonth]),
    ) as Record<PlanTier, number>,
  );

/** STUDIO_IMAGE_GEN_MONTHLY_CAP_<TIER> overrides the A10.4 default (a non-negative integer). */
export function imageGenerationCap(
  tier: PlanTier,
  env: Record<string, string | undefined> = process.env,
): number {
  const name = `STUDIO_IMAGE_GEN_MONTHLY_CAP_${tier}`;
  const raw = env[name]?.trim();
  if (!raw) return DEFAULT_IMAGE_GENERATION_MONTHLY_CAP[tier];
  if (/^\d+$/.test(raw)) return Number(raw);
  logger.warn({ variable: name, value: raw }, '[tier-gates] invalid cap; using the A10.4 default');
  return DEFAULT_IMAGE_GENERATION_MONTHLY_CAP[tier];
}

export interface ImageGenerationUsage {
  businessId: string;
  month: string;
  used: number;
  cap: number;
  remaining: number;
  resetsAt: string;
}

export async function imageGenerationUsage(
  db: Pick<PrismaClient, 'imageLibraryItem'>,
  scope: { organisationId: string; businessId: string; planTier: PlanTier },
  now: number,
  env: Record<string, string | undefined> = process.env,
): Promise<ImageGenerationUsage> {
  const month = monthWindow(now);
  const used = await db.imageLibraryItem.count({
    where: {
      organisationId: scope.organisationId,
      businessId: scope.businessId,
      source: 'GENERATED',
      createdAt: { gte: month.start, lt: month.end },
    },
  });
  const cap = imageGenerationCap(scope.planTier, env);
  return {
    businessId: scope.businessId,
    month: month.key,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    resetsAt: month.end.toISOString(),
  };
}

/** 403 quota_exceeded once the business has used this month's generation cap. */
export async function assertImageGenerationAllowed(
  db: Pick<PrismaClient, 'imageLibraryItem'>,
  scope: { organisationId: string; businessId: string; planTier: PlanTier },
  now: number,
  env: Record<string, string | undefined> = process.env,
): Promise<ImageGenerationUsage> {
  const usage = await imageGenerationUsage(db, scope, now, env);
  if (usage.remaining > 0) return usage;
  throw new QuotaExceededError(
    `This business has used its ${usage.cap} generated images for ${usage.month} on the ${tierLabel(
      scope.planTier,
    )} plan; the allowance resets on ${usage.resetsAt.slice(0, 10)} or upgrade for more`,
    { quota: 'image_generation', ...usage, planTier: scope.planTier },
  );
}
