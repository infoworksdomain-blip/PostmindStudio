import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { carouselEditInput } from '@/lib/studio/carousel/document';
import { previewCarousel } from '@/lib/studio/services/carousels';

// POST /api/studio/projects/:id/carousel/preview (21.6) — the editor's live preview: the unsaved
// carousel's slide breakdown and small JPEG slides (data URLs), rendered exactly as the real
// render, nothing stored and no AI used.
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps, params }) => ({
    body: {
      preview: await previewCarousel(
        deps,
        tenant.organisationId,
        params.id ?? '',
        await parseBody(req, carouselEditInput),
      ),
    },
  }),
  { feature: 'carousels' },
);
