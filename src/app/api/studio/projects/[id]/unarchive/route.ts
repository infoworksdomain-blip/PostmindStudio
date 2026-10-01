import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { setProjectArchived } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/unarchive — restore an archived project to the state it had
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const project = await setProjectArchived(deps.db, tenant.organisationId, id, false);
    audit('studio.project.unarchive', { type: 'video_project', id });
    return { body: { project } };
  },
);
