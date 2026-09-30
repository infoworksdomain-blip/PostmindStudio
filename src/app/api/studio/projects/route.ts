import { StudioCapability } from '@/lib/rbac';
import { featureForProjectSource, featureGateFor } from '@/lib/studio/services/features';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createProject,
  createProjectInput,
  listProjects,
  listProjectsQuery,
} from '@/lib/studio/services/projects';

// GET /api/studio/projects — list (cursor pagination, ?state=&businessId=&days=&limit=&cursor=)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listProjectsQuery);
  return { body: await listProjects(deps.db, tenant.organisationId, query, deps.now()) };
});

// POST /api/studio/projects — create a DRAFT project (spec 8.2)
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createProjectInput);
    // 15.D1: slideshow and library-reference projects need their feature on (A12.4).
    const feature = featureForProjectSource(input.sourceType);
    if (feature) await featureGateFor(deps.db).assertEnabled(feature, tenant.organisationId);
    const project = await createProject(deps.db, tenant, input, deps.now());
    audit('studio.project.create', { type: 'video_project', id: project.id });
    return { status: 201, body: { project } };
  },
);
