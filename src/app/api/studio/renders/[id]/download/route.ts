import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { DOWNLOAD_URL_TTL_SEC, signedRenderUrl } from '@/lib/studio/services/renders';

// GET /api/studio/renders/:id/download — signed MP4 URL (requires studio:render:download)
export const GET = withStudioRoute(
  StudioCapability.RenderDownload,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await signedRenderUrl(deps, tenant.organisationId, id, DOWNLOAD_URL_TTL_SEC);
    audit('studio.render.download', { type: 'video_render', id });
    return { body: result };
  },
);
