import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { costCapsFromEnv } from '@/lib/studio/cost/caps';
import { adminCostCaps } from '@/lib/studio/services/cost-caps';

// GET /api/studio/admin/cost/caps — today's spend against every configured cap (project,
// organisation daily per tier, organisation × provider daily, global daily) and the cost
// alerts of the last 7 days (spec 12.5 / 16.4 Admin Centre cost dashboard).
export const GET = withStudioRoute(StudioCapability.AdminProviders, async ({ deps, tenant }) => {
  requirePlatformStaff(tenant);
  return { body: await adminCostCaps(deps.db, costCapsFromEnv(), deps.now()) };
});
