import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { setProjectArchived } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/archive — hide a project from the default list (kept, restorable)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const project = await setProjectArchived(deps.db, tenant.organisationId, id, true);
    audit('studio.project.archive', { type: 'video_project', id });
    return { body: { project } };
  },
);
