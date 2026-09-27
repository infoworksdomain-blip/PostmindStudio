import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { requestAutoPopulate } from '@/lib/studio/services/slideshows';

// POST /api/studio/projects/:id/auto-populate — fill text and images from the library (A5.5)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await requestAutoPopulate(deps, tenant, id);
    audit('studio.slideshow.auto_populate', { type: 'video_project', id });
    return { status: 202, body: result };
  },
);
