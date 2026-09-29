import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { inviteInput, inviteMember, listInvitations } from '@/lib/studio/services/members';

// GET|POST /api/studio/members/invitations (Phase 18 §2.4) — pending invitations; invite by email
// and role (never owner: ownership moves only by transfer). Studio refuses when the plan's seats
// are full (403 quota_exceeded, reason seat_limit); Better Auth sends the invite email (7-day
// expiry), checks the limit again on acceptance and audits member.invited.
export const GET = withStudioRoute(StudioCapability.MembersManage, async ({ deps, tenant }) => ({
  body: { invitations: await listInvitations(deps.db, tenant.organisationId, deps.now()) },
}));

export const POST = withStudioRoute(
  StudioCapability.MembersManage,
  async ({ req, deps, tenant }) => {
    const input = await parseBody(req, inviteInput);
    const invitation = await inviteMember(deps.db, tenant, req.headers, input, {
      entitlements: deps.entitlements,
      now: deps.now(),
    });
    return { status: 201, body: { invitation } };
  },
);
