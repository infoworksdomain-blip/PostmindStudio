import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { bulkOverlayInput, bulkOverlays } from '@/lib/studio/services/overlays';

// POST /api/studio/renders/:id/overlays/bulk — whole-video overlay, or one per listed shot
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, bulkOverlayInput);
    const overlays = await bulkOverlays(deps.db, tenant.organisationId, params.id ?? '', input);
    audit(
      'studio.overlay.bulk_create',
      { type: 'video_render', id: params.id ?? '' },
      { count: overlays.length },
    );
    return { status: 201, body: { data: overlays } };
  },
  { feature: 'overlays' },
);
