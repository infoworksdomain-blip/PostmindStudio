import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getOrgPolicy, orgPolicyInput, putOrgPolicy } from '@/lib/studio/services/org-policy';

// BACKLOG 13.18 — per-organisation review policy (PostMind staff, studio:admin:moderation).
// GET /api/studio/admin/organisations/:id/policy → the effective policy and where each value
// comes from. PUT (partial) { defaultReviewPolicy?, autoApproveAllowed?, autoApproveTrustThreshold? }
// → the new policy; null resets a value to the platform default. Audited with before/after.
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return { body: { ...(await getOrgPolicy(deps.db, params.id ?? '')) } };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, orgPolicyInput);
    const { before, after } = await putOrgPolicy(deps.db, params.id ?? '', input, tenant.userId);
    audit(
      'studio.admin.org_policy.update',
      { type: 'organisation', id: after.organisationId },
      { before: before.policy, after: after.policy, changed: Object.keys(input) },
    );
    return { body: { ...after } };
  },
);
