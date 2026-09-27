import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { libraryBlueprint } from '@/lib/studio/services/library';

// GET /api/studio/library/blueprint/:libraryVideoId — the TEMPLATE blueprint, before a project
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, params }) => ({
  body: await libraryBlueprint(deps.db, params.libraryVideoId ?? ''),
}));
