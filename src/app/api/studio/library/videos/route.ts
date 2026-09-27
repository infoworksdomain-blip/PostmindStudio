import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listLibraryQuery, listLibraryVideos } from '@/lib/studio/services/library';

// GET /api/studio/library/videos — browse (?category, ?tags, ?durationMin/Max, ?mood, cursor)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, deps }) => ({
  body: await listLibraryVideos(
    { db: deps.db, storage: deps.library.storage },
    parseQuery(req, listLibraryQuery),
  ),
}));
