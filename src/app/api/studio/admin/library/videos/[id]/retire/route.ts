import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { retireLibraryVideo } from '@/lib/studio/services/library';

// POST /api/studio/admin/library/videos/:id/retire — STAFF ONLY: hide from search, keep history
export const POST = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ deps, params, audit }) => {
    const id = params.id ?? '';
    await retireLibraryVideo(deps.db, id, deps.now());
    audit('studio.library.retire', { type: 'video_library', id });
    return { body: { retired: true } };
  },
);
