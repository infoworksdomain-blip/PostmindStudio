import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { inviteInput, inviteMember, listInvitations } from '@/lib/studio/services/members';

// GET|POST /api/studio/members/invitations (Phase 18 §2.4) — pending invitations; invite by email
// and role (never owner: ownership moves only by transfer). Better Auth checks the seat limit,
// sends the invite email (7-day expiry) and audits member.invited.
export const GET = withStudioRoute(StudioCapability.MembersManage, async ({ deps, tenant }) => ({
  body: { invitations: await listInvitations(deps.db, tenant.organisationId, deps.now()) },
}));

export const POST = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant }) => {
    const input = await parseBody(req, inviteInput);
    const invitation = await inviteMember(deps.db, tenant, req.headers, input);
    return { status: 201, body: { invitation } };
  },
);
