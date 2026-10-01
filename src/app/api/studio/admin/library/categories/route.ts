import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { libraryCategories } from '@/lib/studio/services/library';

// GET /api/studio/admin/library/categories — STAFF ONLY: the category tree for the Admin Centre's
// Library tab. The user route (/library/categories) needs an organisation, which platform staff
// may not have (20.10), so the staff pickers (ingest, edit, bulk override, filters) use this one.
export const GET = withStudioRoute(StudioCapability.AdminLibrary, async ({ deps, tenant }) => {
  requirePlatformStaff(tenant);
  return { body: { data: await libraryCategories(deps.db) } };
});
