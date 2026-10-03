import { invalidateIdentity } from '@/lib/identity';
import { StudioCapability, requirePlatformStaff } from '@/lib/rbac';
import { ForbiddenError } from '@/lib/errors';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { banInput, findUserForAction, setUserBan } from '@/lib/studio/services/admin-directory';

// POST /api/studio/admin/users/:id/ban { banned, reason } (Phase 18 §3) — PostMind staff: ban
// (revokes every session at once) or unban a user. Staff accounts are changed only through the
// superadmin CLI. Audited with the reason; the identity cache for the user is dropped.
export const POST = withStudioRoute(
  StudioCapability.AdminUsers,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const userId = params.id ?? '';
    const input = await parseBody(req, banInput);
    const target = await findUserForAction(deps.db, userId);
    if (target.role === 'staff' || target.role === 'superadmin')
      throw new ForbiddenError('Staff accounts are managed with the superadmin CLI', {
        reason: 'target_is_staff',
      });
    const { sessionsRevoked } = await setUserBan(deps.db, userId, input);
    await invalidateIdentity(userId, deps.identity);
    audit(
      input.banned ? 'staff.user_banned' : 'staff.user_unbanned',
      { type: 'user', id: userId },
      { reason: input.reason, sessionsRevoked },
    );
    return { body: { banned: input.banned, sessionsRevoked } };
  },
);
