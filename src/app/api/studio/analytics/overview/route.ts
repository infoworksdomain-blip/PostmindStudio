import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { analyticsOverview, scopedWindowQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/overview?days=7|30|90&businessId= — dashboard totals (spec 8.7);
// businessId (optional, 25.11) narrows to that business's projects within the organisation.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { days, businessId } = parseQuery(req, scopedWindowQuery);
  return {
    body: await analyticsOverview(deps.db, tenant.organisationId, days, deps.now(), businessId),
  };
});
