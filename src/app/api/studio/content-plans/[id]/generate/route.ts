import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { generatePlan } from '@/lib/studio/services/content-plan-run';
import { publicPlan } from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/generate (20.9) — "Generate and schedule": one project per
// post (auto-approved at the owner's say-so, scheduled at its time), allowance reserved per post
// (the first one it cannot cover stops the run: that and later posts are skipped), generation
// throttled by the month-plan runner. Needs project:approve and publication:write as well
// (403 otherwise). A GENERATING plan may be resumed with the same call. At most 3 generating
// plans per organisation (429).
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const plan = await generatePlan(deps, tenant, params.id ?? '');
    audit(
      'studio.content_plan.generate',
      { type: 'content_plan', id: plan.id },
      {
        items: plan.items.length,
        queued: plan.items.filter((i) => i.status === 'QUEUED').length,
        skipped: plan.items.filter((i) => i.status === 'SKIPPED').length,
      },
    );
    return { status: 202, body: { plan: publicPlan(plan) } };
  },
);
