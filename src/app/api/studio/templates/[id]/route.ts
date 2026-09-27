import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { deleteTemplate, findTemplate, presentTemplate } from '@/lib/studio/services/templates';

// GET    /api/studio/templates/:id — one built-in or organisation template
// DELETE /api/studio/templates/:id — delete an organisation template (built-ins are read-only)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      template: presentTemplate(
        await findTemplate(deps.db, tenant.organisationId, params.id ?? ''),
      ),
    },
  }),
);

export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await deleteTemplate(deps.db, tenant.organisationId, id);
    audit('studio.template.delete', { type: 'template', id });
    return { body: { deleted: true } };
  },
);
