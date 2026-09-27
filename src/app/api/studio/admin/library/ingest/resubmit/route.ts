import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { resubmitIngestRuns, resubmitInput } from '@/lib/studio/library/ingest-resubmit';
import { libraryPlanTier } from '@/lib/studio/services/library';

// POST /api/studio/admin/library/ingest/resubmit { runIds?, failedOnly? } — STAFF ONLY:
// re-enqueue failed (or stuck) corpus runs with the item they were submitted with (13.15). 202.
export const POST = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, resubmitInput);
    const result = await resubmitIngestRuns(deps, input, libraryPlanTier());
    audit(
      'studio.library.ingest_resubmit',
      { type: 'video_library', id: 'batch' },
      { queued: result.queued, skipped: result.skipped, failedOnly: input.failedOnly },
    );
    return { status: 202, body: result };
  },
);
