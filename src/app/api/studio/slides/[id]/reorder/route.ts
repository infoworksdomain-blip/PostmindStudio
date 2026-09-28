import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { reorderSlide, reorderSlideInput } from '@/lib/studio/services/slideshows';

// POST /api/studio/slides/:id/reorder — body { newSortOrder }; returns the slides in new order
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params }) => {
    const { newSortOrder } = await parseBody(req, reorderSlideInput);
    return {
      body: {
        data: await reorderSlide(deps.db, tenant.organisationId, params.id ?? '', newSortOrder),
      },
    };
  },
  { feature: 'slideshow' },
);
