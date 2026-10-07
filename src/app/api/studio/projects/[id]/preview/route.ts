import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getPostPreview } from '@/lib/studio/services/post-preview';

// GET /api/studio/projects/:id/preview (24.2) — the calendar side panel's data: instant preview
// media (render, slides, wall-of-text block or storyboard), caption, networks, schedule and live
// status. Scoped to the member's organisation (404 for anyone else's project).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { preview: await getPostPreview(deps, tenant.organisationId, params.id ?? '') },
  }),
);
