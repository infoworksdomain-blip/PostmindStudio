import { hasCapability, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { listInvitations, listMembers, seatUsage } from '@/lib/studio/services/members';

// GET /api/studio/members (Phase 18 §3 /settings/members) — the members table, pending
// invitations (only for callers who manage members) and the seat meter (members + pending
// invitations against the plan's seat limit).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ deps, tenant }) => {
  const canManage = hasCapability(tenant, StudioCapability.MembersManage);
  const [members, invitations] = await Promise.all([
    listMembers(deps.db, tenant),
    listInvitations(deps.db, tenant.organisationId, deps.now()),
  ]);
  const seats = await seatUsage(
    deps.entitlements,
    tenant.organisationId,
    members.length,
    invitations.length,
  );
  return { body: { members, invitations: canManage ? invitations : [], seats, canManage } };
});
