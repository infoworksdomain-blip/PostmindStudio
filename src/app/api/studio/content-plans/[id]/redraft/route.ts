import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { publicPlan, redraftPlan } from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/redraft (20.9) — write the posts that still have no topic
// (after a failed draft). DRAFT → DRAFTING; 409 otherwise.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const plan = await redraftPlan(deps, tenant.organisationId, params.id ?? '');
    audit('studio.content_plan.redraft', { type: 'content_plan', id: plan.id });
    return { status: 202, body: { plan: publicPlan(plan) } };
  },
);
