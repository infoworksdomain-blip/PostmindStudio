import { AuditAction } from '@/lib/audit-sink';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { reasonInput, revokeUserSessions } from '@/lib/studio/services/admin-directory';

// DELETE /api/studio/admin/users/:id/sessions { reason } (Phase 18 §3) — PostMind staff: sign a
// user out everywhere (suspected account takeover). Audited with the reason.
export const DELETE = withStudioRoute(
  StudioCapability.AdminUsers,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const userId = params.id ?? '';
    const { reason } = await parseBody(req, reasonInput);
    const revoked = await revokeUserSessions(deps.db, userId);
    deps.identity?.invalidate(userId);
    audit(AuditAction.SessionRevoked, { type: 'user', id: userId }, { reason, revoked, all: true });
    return { body: { revoked } };
  },
);
