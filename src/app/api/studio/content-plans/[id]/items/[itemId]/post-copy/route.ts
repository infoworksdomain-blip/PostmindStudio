import { hasCapability, StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { findPlan, publicPlan } from '@/lib/studio/services/content-plans';
import { postCopyInput, putPlanItemCopy } from '@/lib/studio/services/post-copy';
import { NotFoundError } from '@/lib/errors';

// PUT /api/studio/content-plans/:id/items/:itemId/post-copy { platform, caption, hashtags[],
// title? } (20.13) — the planned post's caption and hashtags for one of the plan's platforms
// (≥ 5 hashtags including the business hashtag, platform limits). Once the item is generated the
// project's copy and its scheduled posts change too (needs publication:write). → 200 { plan,
// copy, scheduledUpdated }; 409 once the post is out, removed or skipped.
export const PUT = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, postCopyInput);
    const plan = await findPlan(deps.db, tenant.organisationId, params.id ?? '');
    const item = plan.items.find((i) => i.id === params.itemId);
    if (!item) throw new NotFoundError('Plan item not found');
    const result = await putPlanItemCopy(
      deps,
      tenant,
      plan,
      item,
      input,
      hasCapability(tenant, StudioCapability.PublicationWrite),
    );
    audit(
      'studio.content_plan.item_copy_update',
      { type: 'content_plan', id: plan.id },
      {
        itemId: item.id,
        platform: input.platform,
        hashtags: result.copy.hashtags.length,
        scheduledUpdated: result.scheduledUpdated,
      },
    );
    return {
      body: {
        plan: publicPlan(await findPlan(deps.db, tenant.organisationId, plan.id)),
        copy: result.copy,
        scheduledUpdated: result.scheduledUpdated,
      },
    };
  },
);
