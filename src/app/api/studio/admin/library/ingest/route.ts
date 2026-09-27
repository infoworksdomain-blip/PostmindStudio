import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { adminIngest, adminIngestInput } from '@/lib/studio/services/library';

// POST /api/studio/admin/library/ingest — STAFF ONLY: enqueue corpus items (A3.9)
export const POST = withStudioRoute(
  StudioCapability.AdminLibrary,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, adminIngestInput);
    const result = await adminIngest(deps, input);
    audit(
      'studio.library.ingest',
      { type: 'video_library', id: 'batch' },
      { count: result.queued.length },
    );
    return { status: 202, body: result };
  },
);
