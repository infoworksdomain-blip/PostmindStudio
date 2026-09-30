import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  addDraftItem,
  addItemInput,
  findPlan,
  publicPlan,
} from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/items { slotAt, kind, title, brief, slides? } (20.9) — add
// a post at a free time inside the window (at most 4 a day). Drafts only; 201.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, addItemInput);
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    const item = await addDraftItem(deps, plan, input);
    audit(
      'studio.content_plan.item_add',
      { type: 'content_plan', id: plan.id },
      { itemId: item.id },
    );
    return {
      status: 201,
      body: { plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)) },
    };
  },
);
