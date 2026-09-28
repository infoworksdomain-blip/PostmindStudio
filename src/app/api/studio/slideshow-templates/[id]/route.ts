import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { deleteSlideshowTemplate } from '@/lib/studio/services/slideshow-templates';

// DELETE /api/studio/slideshow-templates/:id — BACKLOG 15.E7 (A5.4 /templates): delete one of
// the organisation's saved slideshow templates. Built-ins are read-only (403); another
// organisation's template is a 404.
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const deleted = await deleteSlideshowTemplate(deps.db, tenant.organisationId, params.id ?? '');
    audit('studio.slideshow_template.delete', { type: 'slideshow_template', id: deleted.id });
    return { body: { deleted: true } };
  },
);
