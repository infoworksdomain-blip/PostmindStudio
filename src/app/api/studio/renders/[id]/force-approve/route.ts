import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { forceApproveInput, forceApproveRender } from '@/lib/studio/services/renders';

// POST /api/studio/renders/:id/force-approve — override a failed quality gate (spec 13.5).
// Content-safety BLOCK results are refused (staff moderation only).
export const POST = withStudioRoute(
  StudioCapability.RenderForceApprove,
  async ({ req, tenant, deps, params, audit }) => {
    const { note } = await parseBody(req, forceApproveInput);
    const result = await forceApproveRender(deps.db, tenant, params.id ?? '', note);
    audit('studio.render.force_approve', { type: 'video_render', id: result.renderId }, { note });
    return { body: result };
  },
);
