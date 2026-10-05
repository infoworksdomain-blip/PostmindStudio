import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { rerenderCarousel } from '@/lib/studio/services/carousels';

// POST /api/studio/projects/:id/carousel/render (21.6) — render the saved carousel again after an
// edit (no AI, no allowance used); 202, poll the project state.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const run = await rerenderCarousel(deps, tenant, id);
    audit('studio.carousel.render', { type: 'video_project', id }, { runId: run.runId });
    return { status: 202, body: { projectId: id, state: 'ASSETS_QUEUED', ...run } };
  },
  { feature: 'carousels' },
);
