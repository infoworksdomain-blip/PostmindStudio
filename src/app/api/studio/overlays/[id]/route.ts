import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { deleteOverlay, updateOverlay, updateOverlayInput } from '@/lib/studio/services/overlays';

// PATCH|DELETE /api/studio/overlays/:id — changes apply on the next POST /renders/:id/rerender
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateOverlayInput);
    const overlay = await updateOverlay(deps.db, tenant.organisationId, params.id ?? '', input);
    audit('studio.overlay.update', { type: 'text_overlay', id: overlay.id });
    return { body: { overlay } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deleteOverlay(deps.db, tenant.organisationId, id);
    audit('studio.overlay.delete', { type: 'text_overlay', id });
    return { body: { deleted: true } };
  },
);
