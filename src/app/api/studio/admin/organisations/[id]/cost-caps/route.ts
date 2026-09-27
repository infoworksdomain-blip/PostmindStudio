import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { costCapsFromEnv } from '@/lib/studio/cost/caps';
import {
  getOrgCostCaps,
  orgCostCapsInput,
  putOrgCostCaps,
} from '@/lib/studio/services/org-cost-caps';

// BACKLOG 13.19 — per-organisation cost cap overrides (PostMind staff, studio:admin:providers).
// GET /api/studio/admin/organisations/:id/cost-caps → daily/monthly cap with its source
// (org_override, or plan_tier with every tier's env/default value).
// PUT { dailyPence?, monthlyPence?, reason } → the new caps; null clears a value. Audited
// (studio.admin.cost_caps.override) with before/after and the reason. Workers pick the change up
// within 30 s (cost/org-overrides.ts cache).
export const GET = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ deps, tenant, params }) => {
    requirePlatformStaff(tenant);
    return { body: await getOrgCostCaps(deps.db, params.id ?? '', costCapsFromEnv()) };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.AdminProviders,
  async ({ req, deps, tenant, params, audit }) => {
    requirePlatformStaff(tenant);
    const input = await parseBody(req, orgCostCapsInput);
    const { before, view } = await putOrgCostCaps(
      deps.db,
      params.id ?? '',
      input,
      tenant.userId,
      costCapsFromEnv(),
    );
    audit(
      'studio.admin.cost_caps.override',
      { type: 'organisation', id: view.organisationId },
      {
        before,
        after: {
          dailyPence: view.override?.dailyPence ?? null,
          monthlyPence: view.override?.monthlyPence ?? null,
        },
        reason: input.reason,
      },
    );
    return { body: { ...view } };
  },
);
