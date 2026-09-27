import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getScript } from '@/lib/studio/services/shots';

// GET /api/studio/scripts/:id — one script with all shots
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { script: await getScript(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
