import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { rerenderProject } from '@/lib/studio/services/overlays';

// POST /api/studio/renders/:id/rerender — re-compose with current overlays (no Layer 1-4 spend)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const result = await rerenderProject(deps, tenant, params.id ?? '');
    audit(
      'studio.render.rerender',
      { type: 'video_render', id: params.id ?? '' },
      { runId: result.runId },
    );
    return { status: 202, body: result };
  },
);
