import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { publicationAnalytics } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/publications/:id — latest totals, hourly + daily series, retention
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await publicationAnalytics(deps.db, tenant.organisationId, params.id ?? ''),
  }),
);
