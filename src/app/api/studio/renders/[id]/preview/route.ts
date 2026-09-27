import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { PREVIEW_URL_TTL_SEC, signedRenderUrl } from '@/lib/studio/services/renders';

// GET /api/studio/renders/:id/preview — time-limited signed URL for playback
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await signedRenderUrl(deps, tenant.organisationId, params.id ?? '', PREVIEW_URL_TTL_SEC),
  }),
);
