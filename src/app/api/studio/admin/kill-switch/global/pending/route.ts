import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { cancelGlobalKillRequest } from '@/lib/studio/services/kill-switch-admin';

// DELETE /api/studio/admin/kill-switch/global/pending — BACKLOG 15.D6: withdraw a global kill
// request before it is confirmed (any staff member with kill-switch write; 404 when none).
// Audited.
export const DELETE = withStudioRoute(
  StudioCapability.AdminKillSwitchWrite,
  async ({ deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const request = await cancelGlobalKillRequest(deps.db);
    audit(
      'studio.kill_switch.global_request_withdrawn',
      { type: 'system_flag', id: 'studio.killSwitch' },
      { requestId: request.requestId, requestedBy: request.requestedBy },
    );
    return { body: { withdrawn: request } };
  },
);
