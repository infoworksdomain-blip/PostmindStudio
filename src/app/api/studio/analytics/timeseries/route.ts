import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { analyticsTimeseries, timeseriesQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/timeseries?days=30&metric=views|watchTime|engagement — daily activity
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: await analyticsTimeseries(
    deps.db,
    tenant.organisationId,
    parseQuery(req, timeseriesQuery),
    deps.now(),
  ),
}));
