import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getMembershipGateway } from '@/lib/studio/services/membership-gateway';
import { assertInvitationInOrg } from '@/lib/studio/services/members';

// DELETE /api/studio/members/invitations/:id (Phase 18 §2.4) — revoke a pending invitation of the
// caller's organisation (another organisation's invitation is a 404).
export const DELETE = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant, params }) => {
    const invitation = await assertInvitationInOrg(deps.db, tenant.organisationId, params.id ?? '');
    await getMembershipGateway().cancelInvitation(req.headers, { invitationId: invitation.id });
    return { body: { revoked: true } };
  },
);
