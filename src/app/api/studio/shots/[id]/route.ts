import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getShot, updateShot, updateShotInput } from '@/lib/studio/services/shots';

// GET /api/studio/shots/:id — one shot with its assets
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { shot: await getShot(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

// PATCH /api/studio/shots/:id — edit narration / caption; regenerates voice only
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateShotInput);
    const id = params.id ?? '';
    const result = await updateShot(deps, tenant, id, input);
    audit(
      'studio.shot.update',
      { type: 'video_shot', id },
      { ...result, fields: Object.keys(input) },
    );
    return { status: 202, body: { shotId: id, ...result } };
  },
);
