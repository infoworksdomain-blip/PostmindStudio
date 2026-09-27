import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createPreset,
  createPresetInput,
  listPresets,
  listPresetsQuery,
} from '@/lib/studio/services/overlays';

// GET  /api/studio/overlay-presets — built-in + org + business presets (?group, ?businessId)
// POST /api/studio/overlay-presets — save an org- or business-scoped preset
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: {
    data: await listPresets(deps.db, tenant.organisationId, parseQuery(req, listPresetsQuery)),
  },
}));

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const preset = await createPreset(deps.db, tenant, await parseBody(req, createPresetInput));
    audit('studio.overlay_preset.create', { type: 'overlay_preset', id: preset.id });
    return { status: 201, body: { preset } };
  },
);
