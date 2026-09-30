import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { syncPlanItems } from '@/lib/studio/services/content-plan-run';
import { findPlan, publicPlan } from '@/lib/studio/services/content-plans';

// GET /api/studio/content-plans/:id (20.9) — the plan and its items, each item's status read
// fresh from its project (generating, ready, scheduled, posted, held by safety, failed).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    if (plan.status === 'GENERATING' || plan.status === 'SCHEDULED')
      await syncPlanItems(deps.db, plan.id);
    return { body: { plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)) } };
  },
);
