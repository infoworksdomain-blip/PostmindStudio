import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { userDetail } from '@/lib/studio/services/admin-directory';
import { impersonationEnabled } from '@/lib/studio/admin/impersonation';

// GET /api/studio/admin/users/:id (Phase 18 §3) — PostMind staff: one user and their
// memberships, plus whether impersonation is switched on (the UI shows the button only then).
export const GET = withStudioRoute(
  StudioCapability.AdminUsers,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return {
      body: {
        ...(await userDetail(deps.db, params.id ?? '')),
        impersonation: impersonationEnabled(),
      },
    };
  },
);
