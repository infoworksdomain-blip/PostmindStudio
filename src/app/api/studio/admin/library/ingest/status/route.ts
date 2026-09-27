import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { ingestStatusQuery } from '@/lib/studio/library/ingest-runs';
import { adminIngestStatus } from '@/lib/studio/services/library';

// GET /api/studio/admin/library/ingest/status — STAFF ONLY: corpus ingestion monitoring
// (?windowHours=24, ?failures=20, ?runIds=a,b,… for per-run state). runbooks/corpus-ingestion.md
export const GET = withStudioRoute(StudioCapability.AdminLibrary, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  const query = parseQuery(req, ingestStatusQuery);
  return { body: await adminIngestStatus(deps.db, query, deps.now()) };
});
