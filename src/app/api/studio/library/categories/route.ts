import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { LIBRARY_RESPONSE_HEADERS, libraryCategories } from '@/lib/studio/services/library';

// GET /api/studio/library/categories — the category tree (20.15: shared cache, private max-age)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ deps }) => ({
    body: { data: await libraryCategories(deps.db, deps.libraryCache) },
    headers: { ...LIBRARY_RESPONSE_HEADERS },
  }),
  { feature: 'library' },
);
