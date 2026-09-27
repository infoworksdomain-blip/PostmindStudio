import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getPublication } from '@/lib/studio/services/publications';

// GET /api/studio/publications/:id — state and platform URL once published
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { publication: await getPublication(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
