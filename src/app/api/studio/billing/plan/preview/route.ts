import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  PLAN_IDS,
  PLAN_INTERVALS,
  type PlanId,
  type PlanInterval,
} from '@/lib/studio/billing/plans';

// Phase 21.5 / 26.1 Your plan — GET /api/studio/billing/plan/preview?plan=&interval=: the new price,
// when the change applies (now or at the end of the period) and, for a change that applies now,
// the prorated amount Stripe would invoice today (invoices.createPreview). Nothing is changed.
const query = z.object({
  plan: z.enum(PLAN_IDS as [PlanId, ...PlanId[]]),
  interval: z.enum(PLAN_INTERVALS as [PlanInterval, ...PlanInterval[]]),
});

export const GET = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const next = parseQuery(req, query);
    return { body: { preview: await deps.billing.previewPlanChange(tenant.organisationId, next) } };
  },
);
