import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  findPlan,
  publicPlan,
  reorderDraft,
  reorderInput,
} from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/reorder { itemIds } (20.9) — the post times stay, the
// topics move (the n-th id takes the n-th earliest time). Drafts only (409 otherwise).
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, reorderInput);
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    await reorderDraft(deps.db, plan, input);
    audit('studio.content_plan.reorder', { type: 'content_plan', id: plan.id });
    return { body: { plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)) } };
  },
);
