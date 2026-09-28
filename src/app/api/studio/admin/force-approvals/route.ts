import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { forceApprovalsQuery, listForceApprovals } from '@/lib/studio/services/force-approvals';

// GET /api/studio/admin/force-approvals?days=30&organisationId=&limit= — BACKLOG 15.D5 / spec
// 13.5 "Every force-approve is audited and reviewable in the Admin Centre": renders whose quality
// gate was overridden, with note, user, failed checks, project and organisation. PostMind staff
// with studio:admin:moderation (the same reviewers as content-safety holds).
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    const query = parseQuery(req, forceApprovalsQuery);
    return { body: { ...(await listForceApprovals(deps.db, query, deps.now())) } };
  },
);
