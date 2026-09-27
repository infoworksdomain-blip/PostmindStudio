import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { deletePreset, updatePreset, updatePresetInput } from '@/lib/studio/services/overlays';

// PATCH|DELETE /api/studio/overlay-presets/:id — org/business presets only (not built-ins)
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updatePresetInput);
    const preset = await updatePreset(deps.db, tenant.organisationId, params.id ?? '', input);
    audit('studio.overlay_preset.update', { type: 'overlay_preset', id: preset.id });
    return { body: { preset } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deletePreset(deps.db, tenant.organisationId, id);
    audit('studio.overlay_preset.delete', { type: 'overlay_preset', id });
    return { body: { deleted: true } };
  },
);
