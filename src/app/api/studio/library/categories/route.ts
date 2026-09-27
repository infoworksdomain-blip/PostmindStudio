import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { libraryCategories } from '@/lib/studio/services/library';

// GET /api/studio/library/categories — the category tree
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps }) => ({
  body: { data: await libraryCategories(deps.db) },
}));
