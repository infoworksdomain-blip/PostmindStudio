import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  archiveProject,
  getProjectDetail,
  updateProject,
  updateProjectInput,
} from '@/lib/studio/services/projects';

// GET /api/studio/projects/:id — project with brief, scripts (shot summary), renders, publications
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { project: await getProjectDetail(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

// PATCH /api/studio/projects/:id — edit name, brief, formats, brand kit, policies, budget
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateProjectInput);
    const project = await updateProject(deps.db, tenant.organisationId, params.id ?? '', input);
    audit(
      'studio.project.update',
      { type: 'video_project', id: project.id },
      { fields: Object.keys(input) },
    );
    return { body: { project } };
  },
);

// DELETE /api/studio/projects/:id — archive (soft delete; publications remain)
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await archiveProject(deps.db, tenant.organisationId, id, deps.now());
    audit('studio.project.archive', { type: 'video_project', id });
    return { body: { archived: true } };
  },
);
