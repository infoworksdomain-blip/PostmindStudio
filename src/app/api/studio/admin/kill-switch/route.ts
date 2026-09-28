import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { logger } from '@/lib/logger';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getKillSwitch } from '@/lib/studio/kill-switch';
import {
  changeKillSwitch,
  killSwitchState,
  setKillSwitchInput,
} from '@/lib/studio/services/kill-switch-admin';

// GET|PUT /api/studio/admin/kill-switch — the kill-switch levels (spec 12, Admin Centre 16.4).
// 15.D6 / spec 19.2: engaging the GLOBAL level needs two people. The PUT answers 202 with a
// pending request that a different staff member confirms within 10 minutes
// (POST ./global/confirm). Break-glass STUDIO_KILL_SWITCH_SINGLE_APPROVER=true flips it at once
// (audited breakGlass: true). Releasing, and every other level, applies immediately.
export const GET = withStudioRoute(
  StudioCapability.AdminKillSwitchRead,
  async ({ deps, tenant }) => {
    requirePlatformStaff(tenant);
    const state = await killSwitchState(deps.db, deps.now());
    return {
      body: {
        ...state,
        pendingGlobal: state.pendingGlobal && {
          ...state.pendingGlobal,
          requestedByYou: state.pendingGlobal.requestedBy === tenant.userId,
        },
      },
    };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminKillSwitchWrite,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, setKillSwitchInput);
    const change = await changeKillSwitch(deps.db, tenant, input, deps.now());
    if (change.kind === 'pending') {
      audit(
        'studio.kill_switch.global_requested',
        { type: 'system_flag', id: 'studio.killSwitch' },
        {
          level: 'global',
          reason: input.reason,
          requestId: change.pending.requestId,
          expiresAt: change.pending.expiresAt,
        },
      );
      return { status: 202, body: { pending: change.pending } };
    }
    const { flag, breakGlass } = change;
    (await getKillSwitch()).invalidate();
    if (breakGlass) {
      logger.warn(
        { userId: tenant.userId },
        'global kill switch engaged by one person (STUDIO_KILL_SWITCH_SINGLE_APPROVER)',
      );
    }
    audit(
      input.enabled ? 'studio.kill_switch.engage' : 'studio.kill_switch.release',
      { type: 'system_flag', id: flag.key },
      {
        level: input.level,
        target: input.target ?? null,
        reason: input.reason,
        ...(breakGlass && { breakGlass: true }),
      },
    );
    return {
      body: {
        flag: { key: flag.key, value: flag.value, updatedAt: flag.updatedAt },
        ...(breakGlass && { breakGlass: true }),
      },
    };
  },
);
