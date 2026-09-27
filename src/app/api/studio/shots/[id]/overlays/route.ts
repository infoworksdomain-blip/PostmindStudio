import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  createOverlayInput,
  createShotOverlay,
  listShotOverlays,
} from '@/lib/studio/services/overlays';

// GET|POST /api/studio/shots/:id/overlays
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listShotOverlays(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, createOverlayInput);
    const overlay = await createShotOverlay(deps.db, tenant.organisationId, params.id ?? '', input);
    audit('studio.overlay.create', { type: 'text_overlay', id: overlay.id }, { shotId: params.id });
    return { status: 201, body: { overlay } };
  },
);
