import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { toPlanTier } from '@/lib/studio/services/catalog';
import { usageQuery, usageView } from '@/lib/studio/services/plan-quotas';

// GET /api/studio/usage — decision P3 / spec 12.4: this calendar month's (UTC) video usage against
// the plan's quotas, the quota mode (warn | enforce), alert thresholds, website-scan businesses
// (A10.3) and, with ?businessId=, that business's generated-image allowance (A10.4).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { businessId } = parseQuery(req, usageQuery);
  return {
    body: {
      usage: await usageView(
        deps,
        tenant.organisationId,
        toPlanTier(tenant.organisation.planTier),
        businessId,
        // Phase 18: the trial / ENTERPRISE allowance when Studio bills the organisation.
        deps.entitlements
          ? await deps.entitlements.forOrganisation(tenant.organisationId)
          : undefined,
      ),
    },
  };
});
