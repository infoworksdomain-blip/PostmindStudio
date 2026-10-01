import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  LIBRARY_RESPONSE_HEADERS,
  listLibraryQuery,
  listLibraryVideos,
} from '@/lib/studio/services/library';

// GET /api/studio/library/videos — browse (?category, ?tags, ?durationMin/Max, ?mood, cursor)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, deps }) => ({
    body: await listLibraryVideos(
      { db: deps.db, storage: deps.library.storage, cache: deps.libraryCache, now: deps.now },
      parseQuery(req, listLibraryQuery),
    ),
    headers: { ...LIBRARY_RESPONSE_HEADERS },
  }),
  { feature: 'library' },
);
