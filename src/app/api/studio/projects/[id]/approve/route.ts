import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { approveInput, approveProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/approve — approve renders for publication
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const { note } = await parseBody(req, approveInput);
    const project = await approveProject(deps.db, tenant, params.id ?? '', note, deps.now());
    audit('studio.project.approve', { type: 'video_project', id: project.id });
    return { body: { project } };
  },
);
