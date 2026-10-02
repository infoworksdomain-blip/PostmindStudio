import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { searchLibraryInput, searchLibraryVideos } from '@/lib/studio/services/library';

// POST /api/studio/library/search { q, categorySlug?, limit?, cursor? } — free-text search
// (BACKLOG 13.8). POST because the query is embedded (a provider call), not a cacheable read;
// 20.15 caches the page and the query embedding server-side instead.
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps }) => ({
    body: await searchLibraryVideos(
      {
        db: deps.db,
        storage: deps.library.storage,
        providers: deps.library.providers,
        cache: deps.libraryCache,
        now: deps.now,
      },
      tenant,
      await parseBody(req, searchLibraryInput),
    ),
  }),
  { feature: 'library' },
);
