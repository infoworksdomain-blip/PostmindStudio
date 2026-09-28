import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  listTemplates,
  listTemplatesQuery,
  saveTemplate,
  saveTemplateInput,
} from '@/lib/studio/services/slideshows';

// GET  /api/studio/slideshow-templates — built-in + this organisation's templates (?category)
// POST /api/studio/slideshow-templates — save a slideshow project's structure as a template
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ req, tenant, deps }) => {
    const { category } = parseQuery(req, listTemplatesQuery);
    return { body: { data: await listTemplates(deps.db, tenant.organisationId, category) } };
  },
  { feature: 'slideshow' },
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const template = await saveTemplate(deps.db, tenant, await parseBody(req, saveTemplateInput));
    audit('studio.slideshow_template.create', { type: 'slideshow_template', id: template.id });
    return { status: 201, body: { template } };
  },
  { feature: 'slideshow' },
);
