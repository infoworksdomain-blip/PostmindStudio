import { AuditAction } from '@/lib/audit-sink';
import { reauthenticateRequest } from '@/lib/auth/reauth';
import { studioModes } from '@/lib/mode';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { transferOwnership, transferOwnershipInput } from '@/lib/studio/services/org-settings';

// POST /api/studio/org/transfer-ownership (Phase 18 §2.4) — an owner hands ownership to another
// member and stays on as admin. The role writes go through Better Auth (membership-gateway.ts).
// { memberId, password? }: re-authenticates first (§5.11, standalone mode).
export const POST = withStudioRoute(
  StudioCapability.OrgManage,
  async ({ req, deps, tenant, audit }) => {
    const { memberId, password } = await parseBody(req, transferOwnershipInput);
    if ((deps.modes ?? studioModes()).identity === 'standalone')
      await reauthenticateRequest(req, password);
    await transferOwnership(deps.db, tenant, req.headers, memberId);
    audit(
      AuditAction.MemberRoleChanged,
      { type: 'member', id: memberId },
      { role: 'owner', transfer: true },
    );
    return { body: { transferred: true } };
  },
);
