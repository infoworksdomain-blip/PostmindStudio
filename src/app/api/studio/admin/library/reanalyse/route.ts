import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { libraryPlanTier } from '@/lib/studio/services/library';
import { queueReanalysis, reanalyseInput } from '@/lib/studio/services/library-admin';

// POST /api/studio/admin/library/reanalyse { ids } — STAFF ONLY (15.D7 / A3.8 "Re-run ingestion
// on selected items"): queues re-analysis + re-embedding of the stored sources. 202.
export const POST = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, reanalyseInput);
    const result = await queueReanalysis(deps, input, libraryPlanTier());
    audit(
      'studio.library.reanalyse',
      { type: 'video_library', id: 'batch' },
      { ids: result.queued.map((q) => q.id), skipped: result.skipped.length },
    );
    return { status: 202, body: result };
  },
);
