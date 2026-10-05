import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';

// Phase 21.5 Your plan — POST /api/studio/billing/plan/cancel: the plan ends at the end of the
// period already paid for (cancel_at_period_end); a scheduled change is dropped. → { endsAt }
export const POST = withStudioRoute(StudioCapability.BillingManage, async ({ deps, tenant }) => {
  if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
  const result = await deps.billing.cancelPlan({
    organisationId: tenant.organisationId,
    userId: tenant.userId,
  });
  return { body: result };
});
