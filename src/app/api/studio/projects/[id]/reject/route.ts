import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { rejectInput, rejectProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/reject — halt publication; a note is required
export const POST = withStudioRoute(
  StudioCapability.ProjectApprove,
  async ({ req, tenant, deps, params, audit }) => {
    const { note } = await parseBody(req, rejectInput);
    const project = await rejectProject(deps.db, tenant, params.id ?? '', note, deps.now());
    audit('studio.project.reject', { type: 'video_project', id: project.id }, { note });
    return { body: { project } };
  },
);
