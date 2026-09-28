import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { licenceAudit, licenceAuditQuery } from '@/lib/studio/services/library-admin';

// GET /api/studio/admin/library/licence-audit — STAFF ONLY (15.D7 / A3.8 "Licence-status audit —
// every item must have a licence row"): counts by scenario, missing / expired / expiring within
// 30 days, and the problem rows (?limit=50, max 200).
export const GET = withStudioRoute(StudioCapability.AdminLibrary, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  return { body: await licenceAudit(deps, parseQuery(req, licenceAuditQuery)) };
});
