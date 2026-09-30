import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createPlan,
  createPlanInput,
  listPlans,
  listPlansQuery,
  publicPlan,
} from '@/lib/studio/services/content-plans';
import { featureGateFor } from '@/lib/studio/services/features';

// 20.9 "Plan my month".
// GET /api/studio/content-plans?businessId= — the organisation's month plans (newest first).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listPlansQuery);
  return { body: { data: await listPlans(deps.db, tenant.organisationId, query) } };
});

// POST /api/studio/content-plans { businessId, startDate?, days?, postsPerDay? | useDripSlots,
// videoShare, platforms, targets, timezone?, language?, brandKitId? } → 202 { plan, allowance,
// cost }: the month is laid out and capped at once; Claude writes the topics in the background
// (status DRAFTING → DRAFT). 10 drafts per organisation per 24 hours.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createPlanInput);
    // Slideshow items need the slideshow feature (A12.4), like POST /projects.
    if (input.videoShare < 100)
      await featureGateFor(deps.db).assertEnabled('slideshow', tenant.organisationId);
    const { plan, allowance, cost } = await createPlan(deps, tenant, input);
    audit(
      'studio.content_plan.create',
      { type: 'content_plan', id: plan.id },
      {
        businessId: plan.businessId,
        items: plan.items.length,
        requested: plan.requestedCount,
        cappedReason: plan.cappedReason,
      },
    );
    return { status: 202, body: { plan: publicPlan(plan), allowance, cost } };
  },
);
