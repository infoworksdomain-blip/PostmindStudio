import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { similarInput, similarLibraryVideos } from '@/lib/studio/services/library';

// POST /api/studio/library/videos/:id/similar — nearest neighbours by embedding (20.15: cached)
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, deps, params }) => ({
    body: await similarLibraryVideos(
      { db: deps.db, storage: deps.library.storage, cache: deps.libraryCache, now: deps.now },
      params.id ?? '',
      await parseBody(req, similarInput),
    ),
  }),
  { feature: 'library' },
);
