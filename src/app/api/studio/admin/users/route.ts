import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { searchQuery, searchUsers } from '@/lib/studio/services/admin-directory';

// GET /api/studio/admin/users?q=&offset= (Phase 18 §3 admin Users tab) — PostMind staff
// (studio:admin:users): search by email, name or id; verified, 2FA, role, sessions, banned.
export const GET = withStudioRoute(StudioCapability.AdminUsers, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  return { body: await searchUsers(deps.db, parseQuery(req, searchQuery)) };
});
