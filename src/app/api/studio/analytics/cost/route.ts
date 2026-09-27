import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { analyticsCost, windowQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/cost?days=7|30|90 — cost by provider, project and day (BACKLOG 11.4)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { days } = parseQuery(req, windowQuery);
  return { body: await analyticsCost(deps.db, tenant.organisationId, days, deps.now()) };
});
