import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { cancelProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/cancel — cancel in-flight generation; cost incurred is reported
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const result = await cancelProject(deps, tenant.organisationId, id);
    audit('studio.project.cancel', { type: 'video_project', id }, result);
    return { body: { projectId: id, state: 'FAILED', ...result } };
  },
);
