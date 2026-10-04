import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { carouselEditInput } from '@/lib/studio/carousel/document';
import { getCarousel, saveCarousel } from '@/lib/studio/services/carousels';

// 21.6 carousels.
// GET /api/studio/projects/:id/carousel → { carousel: { carousel, images, render, editable, … } }
// PUT /api/studio/projects/:id/carousel { theme, profile {displayName, handle}, posts[{id, text,
//     imageId}] } → the saved carousel (editable states only; pictures must be the business's).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { carousel: await getCarousel(deps, tenant.organisationId, params.id ?? '') },
  }),
  { feature: 'carousels' },
);

export const PUT = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    const carousel = await saveCarousel(
      deps,
      tenant.organisationId,
      id,
      await parseBody(req, carouselEditInput),
    );
    audit('studio.carousel.update', { type: 'video_project', id });
    return { body: { carousel } };
  },
  { feature: 'carousels' },
);
