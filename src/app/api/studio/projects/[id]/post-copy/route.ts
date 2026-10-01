import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { getPostCopy, postCopyInput, putPostCopy } from '@/lib/studio/services/post-copy';

// 20.13 — the caption and hashtags each platform of the project goes out with.
// GET /api/studio/projects/:id/post-copy → 200 { platforms: { <platform>: { caption, hashtags[],
//     title?, source: owner|generated|none, locked[], min, max, captionMaxChars,
//     captionLimitInBytes, required[], titleMaxChars } }, minHashtags }
// PUT /api/studio/projects/:id/post-copy { platform, caption, hashtags[], title? } → 200 { copy,
//     scheduledUpdated } | 400 (fewer than 5 hashtags incl. the business hashtag, more than the
//     platform allows, caption too long). The edit is what Publish, auto-publish and the
//     project's scheduled (not yet sent) posts use; it decides what is posted, so it needs
//     publication:write like POST /publications.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await getPostCopy(deps.db, tenant.organisationId, params.id ?? ''),
  }),
);

export const PUT = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, postCopyInput);
    const projectId = params.id ?? '';
    const result = await putPostCopy(deps, tenant, projectId, input);
    audit(
      'studio.project.post_copy_update',
      { type: 'video_project', id: projectId },
      {
        platform: input.platform,
        hashtags: result.copy.hashtags.length,
        captionChars: [...result.copy.caption].length,
        scheduledUpdated: result.scheduledUpdated,
      },
    );
    return { body: result };
  },
);
