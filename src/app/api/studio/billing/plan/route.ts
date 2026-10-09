import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  PLAN_IDS,
  PLAN_INTERVALS,
  type PlanId,
  type PlanInterval,
} from '@/lib/studio/billing/plans';

// Phase 21.5 / 26.1 Your plan — POST /api/studio/billing/plan { plan, interval, prorationDate? }:
// change the plan (starter | growth | pro) and / or the billing interval. Upgrades (a higher plan,
// or a longer interval on the same plan) apply now with proration, invoiced at once; downgrades
// (a lower plan, or a shorter interval on the same plan) at the end of the current period.
// prorationDate comes from the preview the customer confirmed, so Stripe charges exactly what
// was shown. Unknown plans, intervals or fields are rejected (400). Owner only.
//   → { outcome: { status: 'applied' | 'scheduled' | 'payment_required', timing, effectiveAt? } }
const changeInput = z
  .object({
    plan: z.enum(PLAN_IDS as [PlanId, ...PlanId[]]),
    interval: z.enum(PLAN_INTERVALS as [PlanInterval, ...PlanInterval[]]),
    prorationDate: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const POST = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const input = await parseBody(req, changeInput);
    const outcome = await deps.billing.changePlan({
      organisationId: tenant.organisationId,
      userId: tenant.userId,
      next: { plan: input.plan, interval: input.interval },
      prorationDate: input.prorationDate ?? null,
    });
    return { body: { outcome } };
  },
);
