import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { listScripts } from '@/lib/studio/services/shots';

// GET /api/studio/projects/:id/scripts — one script per target format, with shots
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listScripts(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
