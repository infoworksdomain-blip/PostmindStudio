import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { carouselDownload } from '@/lib/studio/services/carousels';

// POST /api/studio/projects/:id/carousel/download (21.6) → { url, fileName }: a signed URL of a
// ZIP with every slide of the latest render as PNG (single slides: the pngUrl of each slide in
// GET /carousel).
export const POST = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await carouselDownload(deps, tenant.organisationId, params.id ?? ''),
  }),
  { feature: 'carousels' },
);
