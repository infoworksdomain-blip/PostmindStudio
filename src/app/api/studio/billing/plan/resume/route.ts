import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';

// Phase 21.5 Your plan — POST /api/studio/billing/plan/resume: keep a plan that was set to end
// (only before the period ends). 409 when it is not set to end.
export const POST = withStudioRoute(StudioCapability.BillingManage, async ({ deps, tenant }) => {
  if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
  await deps.billing.resumePlan({ organisationId: tenant.organisationId, userId: tenant.userId });
  return { body: { resumed: true } };
});
