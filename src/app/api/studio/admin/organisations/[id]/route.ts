import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { organisationDetail } from '@/lib/studio/services/admin-directory';

// GET /api/studio/admin/organisations/:id (Phase 18 §3) — PostMind staff: one organisation's
// members, pending invitations, businesses, entitlement and subscriptions (read-only here; the
// existing …/policy, …/cost-caps, …/beta, …/usage and …/purge-plan routes do the rest).
export const GET = withStudioRoute(
  StudioCapability.AdminOrganisations,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return { body: await organisationDetail(deps.db, params.id ?? '', deps.now()) };
  },
);
