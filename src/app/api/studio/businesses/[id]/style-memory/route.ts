import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { listStyleMemory } from '@/lib/studio/services/style-memory';

// GET /api/studio/businesses/:id/style-memory — what Studio has learned about this business
// (BACKLOG 13.29, spec 10.4), each signal with the reason it was inferred.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      data: await listStyleMemory(deps.db, tenant.organisationId, parseBusinessId(params.id)),
    },
  }),
);
