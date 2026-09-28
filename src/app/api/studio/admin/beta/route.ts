import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { betaDashboard, betaDashboardQuery } from '@/lib/studio/services/beta-dashboard';

// BACKLOG 14.11 — staff beta dashboard (Admin → Beta). GET /api/studio/admin/beta?days=30&cohort=
// → per cohort organisation: videos generated / failed / published, failure rate, provider cost
// and feedback count over the window, cohort totals and the latest feedback.
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    return { body: await betaDashboard(deps.db, parseQuery(req, betaDashboardQuery), deps.now()) };
  },
);
