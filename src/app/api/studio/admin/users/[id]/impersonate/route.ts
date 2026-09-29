import { AuditAction } from '@/lib/audit-sink';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  assertCanImpersonate,
  getImpersonationStarter,
  impersonationWriteAllowed,
} from '@/lib/studio/admin/impersonation';
import { reasonInput } from '@/lib/studio/services/admin-directory';

// POST /api/studio/admin/users/:id/impersonate { reason } (Phase 18 §2.5) — superadmin only
// (studio:admin:impersonate). Off unless STUDIO_IMPERSONATION_ENABLED=true; never staff; a reason
// is required; audited before the session starts. The session itself is Better Auth's (30
// minutes, read-only unless STUDIO_IMPERSONATION_WRITE=true).
export const POST = withStudioRoute(
  StudioCapability.AdminImpersonate,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const userId = params.id ?? '';
    const { reason } = await parseBody(req, reasonInput);
    const target = await deps.db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, banned: true, deletedAt: true },
    });
    assertCanImpersonate(tenant, target);
    audit(
      AuditAction.StaffImpersonationStarted,
      { type: 'user', id: target.id },
      { reason, write: impersonationWriteAllowed() },
    );
    const { redirectTo } = await getImpersonationStarter().start(req.headers, {
      userId: target.id,
    });
    return { body: { redirectTo, readOnly: !impersonationWriteAllowed() } };
  },
);
