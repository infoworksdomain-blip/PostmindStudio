import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { businessIdParam } from '@/lib/studio/services/businesses';
import { listScans } from '@/lib/studio/services/scans';

// GET /api/studio/businesses/:id/scans — scan history for a business (A6.8)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      data: await listScans(deps.db, tenant.organisationId, businessIdParam.parse(params.id)),
    },
  }),
);
