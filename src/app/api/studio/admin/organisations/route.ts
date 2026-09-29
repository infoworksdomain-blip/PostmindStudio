import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { searchOrganisations, searchQuery } from '@/lib/studio/services/admin-directory';

// GET /api/studio/admin/organisations?q=&offset= (Phase 18 §3 admin Organisations tab) — PostMind
// staff (studio:admin:organisations, granted only with 2FA): search by name, slug or id, with
// plan, status, member count and cost this month.
export const GET = withStudioRoute(
  StudioCapability.AdminOrganisations,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    return {
      body: await searchOrganisations(deps.db, parseQuery(req, searchQuery), deps.now()),
    };
  },
);
