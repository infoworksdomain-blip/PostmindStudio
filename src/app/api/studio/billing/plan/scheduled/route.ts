import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';

// Phase 21.5 Your plan — DELETE /api/studio/billing/plan/scheduled: keep the current plan and drop
// the change waiting for the end of the period. 409 when nothing is scheduled.
export const DELETE = withStudioRoute(StudioCapability.BillingManage, async ({ deps, tenant }) => {
  if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
  await deps.billing.cancelScheduledChange({
    organisationId: tenant.organisationId,
    userId: tenant.userId,
  });
  return { body: { cancelled: true } };
});
