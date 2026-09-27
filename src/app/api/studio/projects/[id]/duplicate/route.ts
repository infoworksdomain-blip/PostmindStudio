import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { duplicateProject } from '@/lib/studio/services/projects';

// POST /api/studio/projects/:id/duplicate — deep-copy as a new DRAFT
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const project = await duplicateProject(deps.db, tenant, params.id ?? '');
    audit(
      'studio.project.duplicate',
      { type: 'video_project', id: project.id },
      { from: params.id },
    );
    return { status: 201, body: { project } };
  },
);
