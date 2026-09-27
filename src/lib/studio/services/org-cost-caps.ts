import type { OrgCostCap, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { CostCaps } from '../cost/caps';
import { resolveOrgCapByTier } from '../cost/org-overrides';
import { organisationIdParam } from './org-policy';

// BACKLOG 13.19 — GET|PUT /admin/organisations/:id/cost-caps (PostMind staff). The override
// applies to the organisation's daily and monthly caps (cost/org-overrides.ts for the order);
// every change needs a reason and is audited with the before/after values. null clears a value
// (back to the plan tier's cap). An organisation's plan tier comes from Core per request, so
// views without an override list every tier's value.

type Db = Pick<PrismaClient, 'orgCostCap'>;

/** £100,000 a day: a guard against typing pounds as pence ×100, not a policy. */
export const MAX_OVERRIDE_PENCE = 10_000_000;

const capValue = z.number().int().min(1).max(MAX_OVERRIDE_PENCE).nullable().optional();

export const orgCostCapsInput = z
  .object({
    dailyPence: capValue,
    monthlyPence: capValue,
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.dailyPence !== undefined || v.monthlyPence !== undefined, {
    message: 'Send dailyPence and/or monthlyPence (null clears an override)',
  });

export type OrgCostCapsInput = z.infer<typeof orgCostCapsInput>;

function parseOrg(organisationId: string): string {
  const id = organisationIdParam.safeParse(organisationId);
  if (!id.success) throw new ValidationError('Invalid organisation id');
  return id.data;
}

export function viewOrgCostCaps(organisationId: string, row: OrgCostCap | null, caps: CostCaps) {
  const override = row ? { dailyPence: row.dailyPence, monthlyPence: row.monthlyPence } : null;
  const view = (kind: 'daily' | 'monthly') => {
    const own = kind === 'daily' ? override?.dailyPence : override?.monthlyPence;
    return {
      pence: own ?? null,
      source: own != null ? ('org_override' as const) : ('plan_tier' as const),
      byTier: resolveOrgCapByTier(kind, caps, override),
    };
  };
  return {
    organisationId,
    caps: { daily: view('daily'), monthly: view('monthly') },
    override: row
      ? {
          dailyPence: row.dailyPence,
          monthlyPence: row.monthlyPence,
          reason: row.reason,
          updatedByUserId: row.updatedByUserId,
          updatedAt: row.updatedAt,
        }
      : null,
  };
}

export async function getOrgCostCaps(db: Db, organisationId: string, caps: CostCaps) {
  const id = parseOrg(organisationId);
  return viewOrgCostCaps(
    id,
    await db.orgCostCap.findUnique({ where: { organisationId: id } }),
    caps,
  );
}

export async function putOrgCostCaps(
  db: Db,
  organisationId: string,
  input: OrgCostCapsInput,
  actorUserId: string,
  caps: CostCaps,
) {
  const id = parseOrg(organisationId);
  const existing = await db.orgCostCap.findUnique({ where: { organisationId: id } });
  const fields = {
    ...(input.dailyPence !== undefined && { dailyPence: input.dailyPence }),
    ...(input.monthlyPence !== undefined && { monthlyPence: input.monthlyPence }),
    reason: input.reason,
    updatedByUserId: actorUserId,
  };
  const row = await db.orgCostCap.upsert({
    where: { organisationId: id },
    create: { organisationId: id, ...fields },
    update: fields,
  });
  return {
    before: existing
      ? { dailyPence: existing.dailyPence, monthlyPence: existing.monthlyPence }
      : null,
    view: viewOrgCostCaps(id, row, caps),
  };
}
