import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { listRenderOverlays } from '@/lib/studio/services/overlays';

// GET /api/studio/renders/:id/overlays — whole-video overlays applied to this render's platform
// (13.3). Create them with POST /renders/:id/overlays/bulk; edit with /overlays/:id.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listRenderOverlays(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);
