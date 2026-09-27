import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { recommendedLibraryVideos, recommendedQuery } from '@/lib/studio/services/library';

// GET /api/studio/library/recommended?businessId= — nearest to the business profile
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: await recommendedLibraryVideos(
    { db: deps.db, storage: deps.library.storage, providers: deps.library.providers },
    tenant,
    parseQuery(req, recommendedQuery),
  ),
}));
