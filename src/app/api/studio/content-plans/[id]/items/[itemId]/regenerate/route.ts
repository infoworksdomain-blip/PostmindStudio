import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { toPlanTier } from '@/lib/studio/services/catalog';
import { routedPlanGenerator } from '@/lib/studio/services/content-plan-draft';
import { findPlan, publicPlan, regenerateDraftItem } from '@/lib/studio/services/content-plans';

// POST /api/studio/content-plans/:id/items/:itemId/regenerate (20.9) — Claude writes a new,
// different topic for one draft post. At most 60 per plan (429).
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    const itemId = params.itemId ?? '';
    const updated = await regenerateDraftItem(
      {
        db: deps.db,
        now: deps.now,
        generate: routedPlanGenerator(deps.library.providers, {
          organisationId: tenant.organisationId,
          planTier: toPlanTier(tenant.organisation.planTier),
        }),
      },
      plan,
      itemId,
    );
    audit('studio.content_plan.item_regenerate', { type: 'content_plan', id: plan.id }, { itemId });
    return { body: { plan: publicPlan(updated) } };
  },
);
