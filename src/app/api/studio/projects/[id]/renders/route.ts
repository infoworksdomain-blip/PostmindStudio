import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { listRenders } from '@/lib/studio/services/renders';

// GET /api/studio/projects/:id/renders — rendered outputs, newest first
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listRenders(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
