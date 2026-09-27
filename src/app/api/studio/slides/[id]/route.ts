import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { deleteSlide, updateSlide, updateSlideInput } from '@/lib/studio/services/slideshows';

// PATCH|DELETE /api/studio/slides/:id
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateSlideInput);
    const slide = await updateSlide(deps.db, tenant.organisationId, params.id ?? '', input);
    audit(
      'studio.slide.update',
      { type: 'slideshow_slide', id: slide.id },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { slide } };
  },
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deleteSlide(deps.db, tenant.organisationId, id);
    audit('studio.slide.delete', { type: 'slideshow_slide', id });
    return { body: { deleted: true } };
  },
);
