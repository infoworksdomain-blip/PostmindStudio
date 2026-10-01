import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getLibraryVideo, LIBRARY_RESPONSE_HEADERS } from '@/lib/studio/services/library';

// GET /api/studio/library/videos/:id — metadata, analysis, thumbnail, short-lived preview
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ deps, params }) => ({
    body: {
      video: await getLibraryVideo(
        { db: deps.db, storage: deps.library.storage, cache: deps.libraryCache, now: deps.now },
        params.id ?? '',
      ),
    },
    headers: { ...LIBRARY_RESPONSE_HEADERS },
  }),
  { feature: 'library' },
);
