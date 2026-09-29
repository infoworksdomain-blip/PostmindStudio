import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getMembershipGateway } from '@/lib/studio/services/membership-gateway';
import {
  assertCanChangeRole,
  assertCanRemove,
  changeRoleInput,
} from '@/lib/studio/services/members';

// PATCH|DELETE /api/studio/members/:id (Phase 18 §2.4) — change a member's role or remove them.
// Studio's rules run first (admins cannot touch owners, the last owner stays); the write goes
// through Better Auth, which audits it and invalidates the member's cached context.
export const PATCH = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant, params }) => {
    const memberId = params.id ?? '';
    const { role } = await parseBody(req, changeRoleInput);
    await assertCanChangeRole(deps.db, tenant, memberId, role);
    await getMembershipGateway().updateMemberRole(req.headers, {
      organisationId: tenant.organisationId,
      memberId,
      role,
    });
    return { body: { updated: true } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant, params }) => {
    const memberId = params.id ?? '';
    await assertCanRemove(deps.db, tenant, memberId);
    await getMembershipGateway().removeMember(req.headers, {
      organisationId: tenant.organisationId,
      memberId,
    });
    return { body: { removed: true } };
  },
);
