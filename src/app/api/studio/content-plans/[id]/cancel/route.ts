import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { cancelPlan } from '@/lib/studio/services/content-plan-run';
import { publicPlan } from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/cancel (20.9) — cancel every post not yet out (generation
// stopped, scheduled publications cancelled, times freed). Posts already publishing are kept
// (keptPublishing). 409 when the plan has ended.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const result = await cancelPlan(deps, tenant, params.id ?? '');
    audit(
      'studio.content_plan.cancel',
      { type: 'content_plan', id: result.plan.id },
      { keptPublishing: result.keptPublishing },
    );
    return { body: { plan: publicPlan(result.plan), keptPublishing: result.keptPublishing } };
  },
);
