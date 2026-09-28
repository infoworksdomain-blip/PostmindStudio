import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { addSlide, addSlideInput, listSlides } from '@/lib/studio/services/slideshows';

// GET  /api/studio/projects/:id/slides — slides in order, each with `problem` if not renderable
// POST /api/studio/projects/:id/slides — add a slide (at sortOrder, default last)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { data: await listSlides(deps.db, tenant.organisationId, params.id ?? '') },
  }),
  { feature: 'slideshow' },
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const slide = await addSlide(
      deps.db,
      tenant.organisationId,
      params.id ?? '',
      await parseBody(req, addSlideInput),
    );
    audit(
      'studio.slide.create',
      { type: 'slideshow_slide', id: slide.id },
      { projectId: params.id },
    );
    return { status: 201, body: { slide } };
  },
  { feature: 'slideshow' },
);
