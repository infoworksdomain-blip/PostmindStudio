import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { findRender } from '@/lib/studio/services/renders';

// GET /api/studio/renders/:id — render with quality-check details
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const { project: _project, ...render } = await findRender(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
    );
    return { body: { render } };
  },
);
