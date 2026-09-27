import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { analyticsOverview, windowQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/overview?days=7|30|90 — dashboard totals (spec 8.7)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { days } = parseQuery(req, windowQuery);
  return { body: await analyticsOverview(deps.db, tenant.organisationId, days, deps.now()) };
});
