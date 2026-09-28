import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  captionSuggestions,
  captionSuggestionsInput,
  routedGenerator,
} from '@/lib/studio/services/caption-suggestions';

// POST /api/studio/projects/:id/caption-suggestions { refresh? } (15.A7, spec 9.8) → 200
// { suggestions: { <platform>: { caption, hashtags, title?, captionTruncated? } }, language,
// generatedAt, cached }. One Claude call per project; cached on project.metadata.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, captionSuggestionsInput);
    const projectId = params.id ?? '';
    const result = await captionSuggestions(
      {
        db: deps.db,
        now: deps.now,
        generate: routedGenerator(deps.library.providers, {
          organisationId: tenant.organisationId,
          projectId,
          planTier: tenant.organisation.planTier,
        }),
      },
      tenant.organisationId,
      projectId,
      input,
    );
    if (!result.cached)
      audit('studio.project.caption_suggestions', { type: 'video_project', id: projectId });
    return { body: result };
  },
);
