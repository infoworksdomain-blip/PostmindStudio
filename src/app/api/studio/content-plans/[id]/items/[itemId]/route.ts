import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { removeScheduledItem, swapScheduledItem } from '@/lib/studio/services/content-plan-run';
import {
  deleteDraftItem,
  findPlan,
  publicPlan,
  updateDraftItem,
  updateItemInput,
} from '@/lib/studio/services/content-plans';

// PATCH /api/studio/content-plans/:id/items/:itemId { title?, brief?, kind?, slides? } (20.9) —
// edit a draft post; on a generating / scheduled plan, swap the post for the new topic at the
// same time (the old project is taken out of the schedule and a new one prepared: needs
// project:approve and publication:write, and the allowance is checked again).
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateItemInput);
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    const itemId = params.itemId ?? '';
    const draft = plan.status === 'DRAFT';
    if (draft) await updateDraftItem(deps.db, plan, itemId, input);
    else await swapScheduledItem(deps, tenant, plan, itemId, input);
    audit(
      draft ? 'studio.content_plan.item_update' : 'studio.content_plan.item_swap',
      { type: 'content_plan', id: plan.id },
      { itemId },
    );
    return { body: { plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)) } };
  },
);

// DELETE /api/studio/content-plans/:id/items/:itemId (20.9) — drop a draft post, or remove a
// scheduled one before its time (its publication is cancelled and the time freed). 409 once it
// is publishing or posted.
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    const itemId = params.itemId ?? '';
    if (plan.status === 'DRAFT') await deleteDraftItem(deps.db, plan, itemId);
    else await removeScheduledItem(deps, tenant, plan, itemId);
    audit('studio.content_plan.item_remove', { type: 'content_plan', id: plan.id }, { itemId });
    return { body: { plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)) } };
  },
);
