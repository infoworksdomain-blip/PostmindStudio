import { NotImplementedError } from '@/lib/errors';
import { hasCapability, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { billingOverview } from '@/lib/studio/billing/overview';

// Phase 18 §3 /settings/billing — GET /api/studio/billing: plan, status, subscription, usage
// against every plan limit, top-up credits, and whether this user may manage billing.
export const GET = withStudioRoute(StudioCapability.BillingRead, async ({ deps, tenant }) => {
  if (!deps.entitlements)
    throw new NotImplementedError('Billing is not enabled (STUDIO_BILLING is not stripe)');
  const overview = await billingOverview(
    { db: deps.db, entitlements: deps.entitlements, now: deps.now },
    tenant.organisationId,
  );
  return {
    body: {
      billing: {
        ...overview,
        canManage: hasCapability(tenant, StudioCapability.BillingManage),
        checkoutEnabled: Boolean(deps.billing),
      },
    },
  };
});
