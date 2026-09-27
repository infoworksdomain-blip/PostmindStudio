import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { regenerateShot, regenerateShotInput } from '@/lib/studio/services/shots';

// POST /api/studio/shots/:id/regenerate — regenerate just this shot (optional prompt / provider)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, regenerateShotInput);
    const id = params.id ?? '';
    const result = await regenerateShot(deps, tenant, id, input);
    audit(
      'studio.shot.regenerate',
      { type: 'video_shot', id },
      { ...result, providerId: input.providerId ?? null },
    );
    return { status: 202, body: { shotId: id, ...result } };
  },
);
