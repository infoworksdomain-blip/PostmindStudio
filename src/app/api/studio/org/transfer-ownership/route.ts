import { AuditAction } from '@/lib/audit-sink';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { transferOwnership, transferOwnershipInput } from '@/lib/studio/services/org-settings';

// POST /api/studio/org/transfer-ownership (Phase 18 §2.4) — an owner hands ownership to another
// member and stays on as admin. The role writes go through Better Auth (membership-gateway.ts).
export const POST = withStudioRoute(
  StudioCapability.OrgManage,
  async ({ req, deps, tenant, audit }) => {
    const { memberId } = await parseBody(req, transferOwnershipInput);
    await transferOwnership(deps.db, tenant, req.headers, memberId);
    audit(
      AuditAction.MemberRoleChanged,
      { type: 'member', id: memberId },
      { role: 'owner', transfer: true },
    );
    return { body: { transferred: true } };
  },
);
