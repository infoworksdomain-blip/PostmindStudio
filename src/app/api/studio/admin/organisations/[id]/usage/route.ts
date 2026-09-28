import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { adminUsageQuery, organisationUsage } from '@/lib/studio/services/plan-quotas';

// GET /api/studio/admin/organisations/:id/usage — PostMind staff (studio:admin:providers): one
// organisation's plan usage this month (decision P3). Core owns the plan tier, so the view uses
// ?tier= or the tier recorded on the organisation's latest generation (tier.source says which).
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    const query = parseQuery(req, adminUsageQuery);
    return { body: { usage: await organisationUsage(deps, params.id ?? '', query) } };
  },
);
