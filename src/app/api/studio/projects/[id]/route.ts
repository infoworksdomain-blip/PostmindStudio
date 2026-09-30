import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  archiveProject,
  getProjectDetail,
  updateProject,
  updateProjectInput,
} from '@/lib/studio/services/projects';
import { toPlanTier } from '@/lib/studio/services/catalog';
import {
  parseRenderOptionsInput,
  setRenderOptions,
  splitRenderOptions,
} from '@/lib/studio/services/render-options';
import { ValidationError } from '@/lib/errors';

// GET /api/studio/projects/:id — project with brief, scripts (shot summary), renders, publications
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { project: await getProjectDetail(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

// PATCH /api/studio/projects/:id — edit name, brief, formats, brand kit, policies, budget
export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    let body: unknown;
    try {
      const text = await req.text();
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new ValidationError('Request body must be valid JSON');
    }
    // 15.B7: renderOptions (fps, 4K YouTube, 720p drafts) is handled by services/render-options.
    const split = splitRenderOptions(body);
    const renderChange = split.hasRenderOptions
      ? parseRenderOptionsInput(split.renderOptions)
      : undefined;
    const hasRest = Object.keys(split.rest).length > 0 || !split.hasRenderOptions;
    const input = hasRest
      ? await parseBody(
          new Request(req.url, { method: 'PATCH', body: JSON.stringify(split.rest) }),
          updateProjectInput,
        )
      : undefined;
    if (renderChange)
      await setRenderOptions(deps.db, {
        organisationId: tenant.organisationId,
        projectId: id,
        planTier: toPlanTier(tenant.organisation.planTier),
        change: renderChange,
      });
    const project = input
      ? await updateProject(deps.db, tenant, id, input, deps.now())
      : await getProjectDetail(deps.db, tenant.organisationId, id);
    audit(
      'studio.project.update',
      { type: 'video_project', id: project.id },
      {
        fields: [...Object.keys(input ?? {}), ...(renderChange ? ['renderOptions'] : [])],
        ...(renderChange && { renderOptions: renderChange }),
      },
    );
    return { body: { project } };
  },
);

// DELETE /api/studio/projects/:id — archive (soft delete; publications remain)
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const id = params.id ?? '';
    await archiveProject(deps.db, tenant.organisationId, id, deps.now());
    audit('studio.project.archive', { type: 'video_project', id });
    return { body: { archived: true } };
  },
);
