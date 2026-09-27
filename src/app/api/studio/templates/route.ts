import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  listTemplates,
  listTemplatesQuery,
  presentTemplate,
  saveProjectTemplate,
  saveTemplateInput,
} from '@/lib/studio/services/templates';

// GET  /api/studio/templates — built-in + this organisation's project templates (?category), spec 8.6
// POST /api/studio/templates — save a project's current shape as a reusable template
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { category } = parseQuery(req, listTemplatesQuery);
  return { body: { data: await listTemplates(deps.db, tenant.organisationId, category) } };
});

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, saveTemplateInput);
    const template = await saveProjectTemplate(deps.db, tenant, input);
    audit(
      'studio.template.create',
      { type: 'template', id: template.id },
      { projectId: input.projectId },
    );
    return { status: 201, body: { template: presentTemplate(template) } };
  },
);
