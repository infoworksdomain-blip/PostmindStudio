import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  createSlideOverlay,
  createSlideOverlayInput,
  listSlideOverlays,
} from '@/lib/studio/services/overlays';

// GET|POST /api/studio/slides/:id/overlays — per-slide text overlays (13.4). Timing is relative
// to the slide; without startAtSec/endAtSec the overlay spans the whole slide.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listSlideOverlays(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, createSlideOverlayInput);
    const overlay = await createSlideOverlay(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
      input,
    );
    audit(
      'studio.overlay.create',
      { type: 'text_overlay', id: overlay.id },
      { slideId: params.id },
    );
    return { status: 201, body: { overlay } };
  },
);
