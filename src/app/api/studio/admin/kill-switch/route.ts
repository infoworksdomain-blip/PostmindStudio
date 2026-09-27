import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getKillSwitch } from '@/lib/studio/kill-switch';
import {
  killSwitchState,
  setKillSwitch,
  setKillSwitchInput,
} from '@/lib/studio/services/kill-switch-admin';

// GET|PUT /api/studio/admin/kill-switch — the four levels (spec 12, Admin Centre 16.4)
export const GET = withStudioRoute(
  StudioCapability.AdminKillSwitchRead,
  async ({ deps, tenant }) => {
    requirePlatformStaff(tenant);
    return {
      body: await killSwitchState(deps.db),
    };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminKillSwitchWrite,
  async ({ req, deps, audit, tenant }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, setKillSwitchInput);
    const flag = await setKillSwitch(deps.db, input);
    (await getKillSwitch()).invalidate();
    audit(
      input.enabled ? 'studio.kill_switch.engage' : 'studio.kill_switch.release',
      { type: 'system_flag', id: flag.key },
      { level: input.level, target: input.target ?? null, reason: input.reason },
    );
    return { body: { flag: { key: flag.key, value: flag.value, updatedAt: flag.updatedAt } } };
  },
);
