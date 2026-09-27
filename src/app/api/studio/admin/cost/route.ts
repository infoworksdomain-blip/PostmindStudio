import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { adminCostDashboard, adminCostQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/admin/cost?days=30&organisationId= — Admin Centre cost dashboard (spec 16.4)
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    return {
      body: await adminCostDashboard(deps.db, parseQuery(req, adminCostQuery), deps.now()),
    };
  },
);
