import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { bulkInput, bulkReviewLibraryVideos } from '@/lib/studio/services/library-admin';

// POST /api/studio/admin/library/videos/bulk { ids, action: accept|override|reject, categoryId? }
// STAFF ONLY (15.D7 / A3.8 "Bulk-edit categorisation"). At most 100 ids; reject also retires.
export const POST = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, bulkInput);
    const result = await bulkReviewLibraryVideos(deps, input);
    audit(
      'studio.library.bulk_review',
      { type: 'video_library', id: 'batch' },
      {
        action: result.action,
        ids: result.updated,
        missing: result.missing.length,
        retired: result.retired,
        categoryId: result.categoryId,
      },
    );
    return { body: result };
  },
);
