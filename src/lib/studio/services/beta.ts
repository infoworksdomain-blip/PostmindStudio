import type { OrganisationBeta, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import type { PlanTier } from '../providers/router';
import { toPlanTier } from './catalog';
import { organisationIdParam } from './org-policy';

// BACKLOG 14.11 — beta programme cohort per organisation (playbook 10.4: beta customers get
// "Plus for 30 days"). PostMind Core owns billing and reports the organisation's plan tier in
// its context; Studio cannot change that. What Studio CAN do is route, cap and auto-approve the
// organisation as PLUS while the beta lasts: applyBetaPlan() rewrites
// tenant.organisation.planTier for every /api/studio request (withStudioRoute), and every
// consumer — the provider router (via the run's planTier), cost caps (orgDailyPenceByTier),
// auto-approve / auto-publish (the outbox's planTier) — reads it from there.
//
//   - The override only RAISES the tier: an ENTERPRISE organisation stays ENTERPRISE.
//   - It ends at plusUntil (checked on every request). Work enqueued before then keeps the tier
//     it was enqueued with (the planTier travels in the job data), as with a Core plan change.
//   - Lookups are cached per process for BETA_CACHE_TTL_MS; PUT clears this process's entry, so
//     other instances pick a change up within that TTL.

export const BETA_PLUS_TIER: PlanTier = 'PLUS';
export const BETA_DEFAULT_PLUS_DAYS = 30;
export const BETA_MAX_PLUS_DAYS = 365;
export const BETA_CACHE_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TIER_RANK: Record<PlanTier, number> = { BASIC: 0, STANDARD: 1, PLUS: 2, ENTERPRISE: 3 };

export const betaCohortInput = z
  .object({
    cohort: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - and _ only'),
    /**
     * When the Plus override ends. Omitted on enrolment = now + 30 days (playbook 10.4); omitted
     * on an update keeps the current value; null = cohort member without the Plus override.
     */
    plusUntil: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type BetaCohortInput = z.infer<typeof betaCohortInput>;

export interface BetaView {
  organisationId: string;
  cohort: string;
  plusUntil: string | null;
  /** True while plusUntil is in the future. */
  plusActive: boolean;
  enrolledAt: string;
  updatedAt: string;
  updatedByUserId: string;
}

export function plusActive(beta: Pick<OrganisationBeta, 'plusUntil'> | null, now: number): boolean {
  return Boolean(beta?.plusUntil && beta.plusUntil.getTime() > now);
}

export function viewBeta(row: OrganisationBeta, now: number): BetaView {
  return {
    organisationId: row.organisationId,
    cohort: row.cohort,
    plusUntil: row.plusUntil?.toISOString() ?? null,
    plusActive: plusActive(row, now),
    enrolledAt: row.enrolledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  };
}

function parseOrgId(organisationId: string): string {
  const parsed = organisationIdParam.safeParse(organisationId);
  if (!parsed.success) throw new ValidationError('Invalid organisation id');
  return parsed.data;
}

type BetaDb = Pick<PrismaClient, 'organisationBeta'>;

export async function getBeta(
  db: BetaDb,
  organisationId: string,
  now: number,
): Promise<{ organisationId: string; beta: BetaView | null }> {
  const org = parseOrgId(organisationId);
  const row = await db.organisationBeta.findUnique({ where: { organisationId: org } });
  return { organisationId: org, beta: row ? viewBeta(row, now) : null };
}

function resolvePlusUntil(
  input: BetaCohortInput,
  existing: OrganisationBeta | null,
  now: number,
): Date | null {
  if (input.plusUntil === null) return null;
  if (input.plusUntil === undefined)
    return existing ? existing.plusUntil : new Date(now + BETA_DEFAULT_PLUS_DAYS * DAY_MS);
  const until = new Date(input.plusUntil);
  if (until.getTime() <= now) throw new ValidationError('plusUntil must be in the future');
  if (until.getTime() > now + BETA_MAX_PLUS_DAYS * DAY_MS)
    throw new ValidationError(`plusUntil must be within ${BETA_MAX_PLUS_DAYS} days`);
  return until;
}

/** Enrol or update an organisation's beta cohort. Returns before/after for the audit entry. */
export async function putBeta(
  db: BetaDb,
  organisationId: string,
  input: BetaCohortInput,
  actorUserId: string,
  now: number,
): Promise<{ before: BetaView | null; after: BetaView }> {
  const org = parseOrgId(organisationId);
  const existing = await db.organisationBeta.findUnique({ where: { organisationId: org } });
  const plusUntil = resolvePlusUntil(input, existing, now);
  const row = await db.organisationBeta.upsert({
    where: { organisationId: org },
    create: { organisationId: org, cohort: input.cohort, plusUntil, updatedByUserId: actorUserId },
    update: { cohort: input.cohort, plusUntil, updatedByUserId: actorUserId },
  });
  return { before: existing ? viewBeta(existing, now) : null, after: viewBeta(row, now) };
}

/** The effective tier: at least PLUS while the beta override is active, never lower than Core's. */
export function effectivePlanTier(
  coreTier: string | undefined,
  beta: Pick<OrganisationBeta, 'plusUntil'> | null,
  now: number,
): PlanTier {
  const tier = toPlanTier(coreTier);
  if (!plusActive(beta, now)) return tier;
  return TIER_RANK[tier] >= TIER_RANK[BETA_PLUS_TIER] ? tier : BETA_PLUS_TIER;
}

export interface BetaPlanLookup {
  /** The organisation's beta row (or null), possibly cached. */
  find(organisationId: string): Promise<Pick<OrganisationBeta, 'plusUntil'> | null>;
  /** Drop this process's cached entry (after a staff change). */
  invalidate(organisationId: string): void;
}

export function createBetaPlanLookup(deps: {
  db: BetaDb;
  logger: Pick<Logger, 'warn'>;
  now: () => number;
  ttlMs?: number;
}): BetaPlanLookup {
  const ttl = deps.ttlMs ?? BETA_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; value: { plusUntil: Date | null } | null }>();
  return {
    async find(organisationId) {
      const hit = cache.get(organisationId);
      if (hit && deps.now() - hit.at < ttl) return hit.value;
      try {
        const value = await deps.db.organisationBeta.findUnique({
          where: { organisationId },
          select: { plusUntil: true },
        });
        cache.set(organisationId, { at: deps.now(), value });
        return value;
      } catch (err) {
        // Degrade to Core's tier (never a higher one) rather than failing every request; logged
        // so a broken table is visible. Not cached: the next request tries again.
        deps.logger.warn({ err, organisationId }, 'beta plan lookup failed; using Core plan tier');
        return null;
      }
    },
    invalidate(organisationId) {
      cache.delete(organisationId);
    },
  };
}

/**
 * The tenant with the beta override applied (a new object; the input is not mutated). Without a
 * lookup (tests, or no database) the tenant is returned unchanged.
 */
export async function applyBetaPlan(
  lookup: BetaPlanLookup | undefined,
  tenant: TenantContext,
  now: number,
): Promise<TenantContext> {
  if (!lookup) return tenant;
  const beta = await lookup.find(tenant.organisationId);
  if (!plusActive(beta, now)) return tenant;
  const tier = effectivePlanTier(tenant.organisation.planTier, beta, now);
  if (tier === toPlanTier(tenant.organisation.planTier)) return tenant;
  return { ...tenant, organisation: { ...tenant.organisation, planTier: tier } };
}
