import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { adminListLibraryVideos, adminListQuery } from '@/lib/studio/services/library-admin';

// GET /api/studio/admin/library/videos — STAFF ONLY (15.D7 / A3.8): every corpus row, including
// unlicensed and retired ones, with licence status per row.
// ?licence=missing|LICENSED|OWNED|SCRAPED|NOT_REQUIRED &retired=true|false
// &review=unreviewed|ACCEPTED|OVERRIDDEN|REJECTED &category= &q= &cursor= &limit=
export const GET = withStudioRoute(StudioCapability.AdminLibrary, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  const query = parseQuery(req, adminListQuery);
  return { body: await adminListLibraryVideos(deps, query) };
});
