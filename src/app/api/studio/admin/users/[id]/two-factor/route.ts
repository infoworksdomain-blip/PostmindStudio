import { AuditAction } from '@/lib/audit-sink';
import { ForbiddenError } from '@/lib/errors';
import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  findUserForAction,
  reasonInput,
  resetUserTwoFactor,
} from '@/lib/studio/services/admin-directory';

// DELETE /api/studio/admin/users/:id/two-factor { reason } (Phase 18 §3, runbooks/auth.md "Lost
// authenticator") — PostMind staff: remove a user's TOTP secret and backup codes after identity
// has been verified out of band; ends their sessions. Never for staff accounts (their 2FA is
// reset only by a superadmin through the CLI). Audited with the reason.
export const DELETE = withStudioRoute(
  StudioCapability.AdminUsers,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const userId = params.id ?? '';
    const { reason } = await parseBody(req, reasonInput);
    const target = await findUserForAction(deps.db, userId);
    if (target.role === 'staff' || target.role === 'superadmin')
      throw new ForbiddenError('Staff 2FA is reset with the superadmin CLI', {
        reason: 'target_is_staff',
      });
    await resetUserTwoFactor(deps.db, userId);
    deps.identity?.invalidate(userId);
    audit(AuditAction.TwoFactorDisabled, { type: 'user', id: userId }, { reason, byStaff: true });
    return { body: { reset: true } };
  },
);
