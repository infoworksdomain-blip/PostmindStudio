import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { UnprocessableError, ValidationError } from '../../errors';
import type { PlanTier } from '../providers/router';
import { enterpriseMinimumMonthlyPricePence, PLAN_CATALOGUE, TIER_ORDER } from './catalogue';
import {
  customLimitsSchema,
  parseOverrides,
  resolveStoredEntitlements,
  tierOfSubscription,
  type AdminOverride,
  type EntitlementOverrides,
} from './entitlements';
import { invalidateEntitlements, type Entitlements } from './entitlements-reader';

// Phase 18 §P.3 / §P.4 — staff tools (studio:admin:billing + platform staff):
//   - per-organisation entitlement override: tier, access, custom limits (ENTERPRISE quotas,
//     seats, businesses, storage), a reason (required) and an optional expiry. Cost-cap overrides
//     stay in the existing org_cost_caps panel (13.19). An ENTERPRISE override needs the agreed
//     monthly price, and it must be at least the §P.2 minimum for the organisation's monthly cost
//     cap (15 % gross margin at the cap), so no custom deal loses money at the cap.
//   - the subscriptions list with MRR.

const organisationIdParam = z.string().trim().min(1).max(128);

export const adminEntitlementInput = z
  .object({
    tier: z.enum(['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE']).optional(),
    access: z.enum(['full', 'read_only', 'none']).optional(),
    limits: customLimitsSchema.optional(),
    monthlyPricePence: z.number().int().min(0).max(100_000_000).nullable().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type AdminEntitlementInput = z.infer<typeof adminEntitlementInput>;

export const adminEntitlementClearInput = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

type AdminDb = Pick<PrismaClient, 'orgEntitlement' | 'orgCostCap' | 'subscription'>;

function parseOrgId(id: string): string {
  const parsed = organisationIdParam.safeParse(id);
  if (!parsed.success) throw new ValidationError('Invalid organisation id');
  return parsed.data;
}

/** The monthly cost cap the minimum price is computed from: the org's override or the default. */
async function monthlyCapFor(db: AdminDb, organisationId: string, tier: PlanTier) {
  const own = await db.orgCostCap.findUnique({ where: { organisationId } });
  return own?.monthlyPence ?? PLAN_CATALOGUE[tier].monthlyCostCapPence;
}

export interface AdminEntitlementView {
  organisationId: string;
  effective: Entitlements;
  stored: {
    tier: string;
    access: string;
    source: string;
    graceUntil: string | null;
    trialStartedAt: string | null;
    everPaidAt: string | null;
    updatedAt: string | null;
  } | null;
  admin: AdminOverride | null;
  limits: EntitlementOverrides['limits'] | null;
  enterprise: { monthlyCapPence: number; minimumMonthlyPricePence: number };
  subscriptions: Array<{
    id: string;
    status: string;
    tier: PlanTier | null;
    interval: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
}

export async function getAdminEntitlements(
  db: AdminDb,
  organisationId: string,
  now: Date,
): Promise<AdminEntitlementView> {
  const orgId = parseOrgId(organisationId);
  const [row, subs] = await Promise.all([
    db.orgEntitlement.findUnique({ where: { organisationId: orgId } }),
    db.subscription.findMany({ where: { organisationId: orgId }, orderBy: { createdAt: 'desc' } }),
  ]);
  const overrides = parseOverrides(row?.overrides);
  const effective = row
    ? resolveStoredEntitlements(row, now)
    : resolveStoredEntitlements(
        {
          organisationId: orgId,
          tier: 'BASIC',
          access: 'none',
          source: 'none',
          graceUntil: null,
          overrides: {},
          everPaidAt: null,
        },
        now,
      );
  const monthlyCapPence = await monthlyCapFor(db, orgId, 'ENTERPRISE');
  return {
    organisationId: orgId,
    effective,
    stored: row
      ? {
          tier: row.tier,
          access: row.access,
          source: row.source,
          graceUntil: row.graceUntil?.toISOString() ?? null,
          trialStartedAt: row.trialStartedAt?.toISOString() ?? null,
          everPaidAt: row.everPaidAt?.toISOString() ?? null,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
    admin: overrides.admin ?? null,
    limits: overrides.limits ?? null,
    enterprise: {
      monthlyCapPence,
      minimumMonthlyPricePence: enterpriseMinimumMonthlyPricePence(monthlyCapPence),
    },
    subscriptions: subs.map((s) => ({
      id: s.id,
      status: s.status,
      tier: tierOfSubscription(s) ?? null,
      interval: s.interval,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    })),
  };
}

async function writeOverrides(
  db: AdminDb,
  organisationId: string,
  next: EntitlementOverrides,
  staffUserId: string,
  reason: string,
  now: Date,
) {
  const existing = await db.orgEntitlement.findUnique({ where: { organisationId } });
  const effective = resolveStoredEntitlements(
    {
      organisationId,
      tier: existing?.tier ?? 'BASIC',
      access: existing?.access ?? 'none',
      source: existing?.source ?? 'none',
      graceUntil: existing?.graceUntil ?? null,
      overrides: next,
      everPaidAt: existing?.everPaidAt ?? null,
    },
    now,
  );
  const data = {
    tier: effective.tier,
    access: effective.access,
    source: effective.source,
    overrides: next as Prisma.InputJsonValue,
    reason: reason.slice(0, 200),
    updatedByUserId: staffUserId,
  };
  // Keep the Stripe-derived value when the override later expires or is cleared.
  const derived = next.derived ?? {
    tier: (existing?.tier as PlanTier | undefined) ?? 'BASIC',
    access: (existing?.access as 'full' | 'read_only' | 'none' | undefined) ?? 'none',
    source: 'none' as const,
    status: null,
  };
  await db.orgEntitlement.upsert({
    where: { organisationId },
    create: {
      organisationId,
      ...data,
      overrides: { ...next, derived } as Prisma.InputJsonValue,
    },
    update: data,
  });
  invalidateEntitlements(organisationId);
  return effective;
}

export async function putAdminEntitlements(
  db: AdminDb,
  organisationId: string,
  input: AdminEntitlementInput,
  staffUserId: string,
  now: Date,
): Promise<{ before: Entitlements; after: AdminEntitlementView }> {
  const orgId = parseOrgId(organisationId);
  if (input.expiresAt && Date.parse(input.expiresAt) <= now.getTime())
    throw new ValidationError('expiresAt must be in the future');
  const beforeView = await getAdminEntitlements(db, orgId, now);
  const tier = input.tier ?? beforeView.effective.tier;
  if (tier === 'ENTERPRISE') {
    const minimum = beforeView.enterprise.minimumMonthlyPricePence;
    if (input.monthlyPricePence == null)
      throw new ValidationError('An ENTERPRISE override needs the agreed monthly price', {
        minimumMonthlyPricePence: minimum,
      });
    if (input.monthlyPricePence < minimum)
      throw new UnprocessableError(
        `The monthly price is below the minimum for this organisation's cost cap (${minimum} pence)`,
        {
          reason: 'below_minimum_price',
          minimumMonthlyPricePence: minimum,
          monthlyCapPence: beforeView.enterprise.monthlyCapPence,
        },
      );
  }
  const row = await db.orgEntitlement.findUnique({ where: { organisationId: orgId } });
  const overrides = parseOverrides(row?.overrides);
  const admin: AdminOverride = {
    ...(input.tier && { tier: input.tier }),
    ...(input.access && { access: input.access }),
    expiresAt: input.expiresAt ?? null,
    reason: input.reason,
    setByUserId: staffUserId,
    setAt: now.toISOString(),
    monthlyPricePence: input.monthlyPricePence ?? null,
  };
  await writeOverrides(
    db,
    orgId,
    { ...overrides, admin, ...(input.limits && { limits: input.limits }) },
    staffUserId,
    input.reason,
    now,
  );
  return { before: beforeView.effective, after: await getAdminEntitlements(db, orgId, now) };
}

export async function clearAdminEntitlements(
  db: AdminDb,
  organisationId: string,
  reason: string,
  staffUserId: string,
  now: Date,
): Promise<{ before: Entitlements; after: AdminEntitlementView }> {
  const orgId = parseOrgId(organisationId);
  const beforeView = await getAdminEntitlements(db, orgId, now);
  const row = await db.orgEntitlement.findUnique({ where: { organisationId: orgId } });
  if (row) {
    const rest = Object.fromEntries(
      Object.entries(parseOverrides(row.overrides)).filter(
        ([k]) => k !== 'admin' && k !== 'limits',
      ),
    ) as EntitlementOverrides;
    await writeOverrides(db, orgId, rest, staffUserId, reason, now);
  }
  return { before: beforeView.effective, after: await getAdminEntitlements(db, orgId, now) };
}

// ------------------------------------------------------------------ subscriptions + MRR

export const adminSubscriptionsQuery = z.object({
  status: z
    .enum(['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const MRR_STATUSES = new Set(['active', 'past_due']);

/** Monthly recurring revenue of one subscription in pence (annual ÷ 12), ex-VAT. */
export function monthlyRevenuePence(sub: {
  status: string;
  unitAmountPence: number | null;
  quantity: number;
  interval: string | null;
}): number {
  if (!MRR_STATUSES.has(sub.status) || sub.unitAmountPence == null) return 0;
  const total = sub.unitAmountPence * sub.quantity;
  return sub.interval === 'year' ? Math.round(total / 12) : total;
}

export async function listAdminSubscriptions(
  db: Pick<PrismaClient, 'subscription' | 'organization'>,
  query: z.infer<typeof adminSubscriptionsQuery>,
) {
  const all = await db.subscription.findMany({
    select: {
      id: true,
      organisationId: true,
      status: true,
      lookupKey: true,
      productTier: true,
      interval: true,
      unitAmountPence: true,
      currency: true,
      quantity: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      trialEnd: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const byTier = Object.fromEntries(
    TIER_ORDER.map((t) => [t, { count: 0, mrrPence: 0 }]),
  ) as Record<PlanTier, { count: number; mrrPence: number }>;
  const byStatus: Record<string, number> = {};
  let mrrPence = 0;
  for (const sub of all) {
    byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
    const mrr = monthlyRevenuePence(sub);
    mrrPence += mrr;
    const tier = tierOfSubscription(sub);
    if (tier && (MRR_STATUSES.has(sub.status) || sub.status === 'trialing')) {
      byTier[tier].count += 1;
      byTier[tier].mrrPence += mrr;
    }
  }
  const rows = all.filter((s) => !query.status || s.status === query.status).slice(0, query.limit);
  const names = new Map(
    (
      await db.organization.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.organisationId))] } },
        select: { id: true, name: true },
      })
    ).map((o) => [o.id, o.name]),
  );
  return {
    summary: { mrrPence, currency: 'gbp', byStatus, byTier, total: all.length },
    subscriptions: rows.map((s) => ({
      id: s.id,
      organisationId: s.organisationId,
      organisationName: names.get(s.organisationId) ?? null,
      status: s.status,
      tier: tierOfSubscription(s) ?? null,
      interval: s.interval,
      mrrPence: monthlyRevenuePence(s),
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      trialEnd: s.trialEnd?.toISOString() ?? null,
    })),
  };
}
