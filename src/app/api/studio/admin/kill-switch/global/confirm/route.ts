import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getKillSwitch } from '@/lib/studio/kill-switch';
import { confirmGlobalKill, confirmGlobalKillInput } from '@/lib/studio/services/kill-switch-admin';

// POST /api/studio/admin/kill-switch/global/confirm { requestId, reason } — BACKLOG 15.D6 / spec
// 19.2 "global generation kill with two-person approval". A staff member other than the requester
// confirms the pending request within 10 minutes; the global flag is then set. 403 for the
// requester, 404 when nothing is pending, 409 when the request expired, changed or was already
// used. Audited as studio.kill_switch.engage with both people.
export const POST = withStudioRoute(
  StudioCapability.AdminKillSwitchWrite,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, confirmGlobalKillInput);
    const { flag, request } = await confirmGlobalKill(deps.db, tenant, input, deps.now());
    (await getKillSwitch()).invalidate();
    audit(
      'studio.kill_switch.engage',
      { type: 'system_flag', id: flag.key },
      {
        level: 'global',
        target: null,
        reason: input.reason,
        twoPerson: true,
        requestId: request.requestId,
        requestedBy: request.requestedBy,
        requestReason: request.reason,
        requestedAt: request.requestedAt,
        confirmedBy: tenant.userId,
      },
    );
    return {
      body: {
        flag: { key: flag.key, value: flag.value, updatedAt: flag.updatedAt },
        request,
      },
    };
  },
);
