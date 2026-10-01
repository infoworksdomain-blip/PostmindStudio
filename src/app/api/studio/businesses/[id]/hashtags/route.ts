import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  businessHashtagsInput,
  getBusinessHashtags,
  putBusinessHashtags,
} from '@/lib/studio/services/business-hashtags';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// 20.13 — the business hashtag and the owner's "always include" hashtags (Business settings).
// GET /api/studio/businesses/:id/hashtags → 200 { hashtags: { primaryHashtag, derivedHashtag,
//     custom, alwaysHashtags[], minHashtags, maxChars, maxAlways, updatedAt } }
// PUT /api/studio/businesses/:id/hashtags { primaryHashtag: string | null, alwaysHashtags: [] }
//     → 200 { hashtags } | 400 { details: { field, problem } } (letters/digits/_ only, ≤ 30
//     characters, at least one letter). Every post of the business carries these (policy.ts).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      hashtags: await getBusinessHashtags(deps.db, {
        organisationId: tenant.organisationId,
        businessId: parseBusinessId(params.id),
      }),
    },
  }),
);

export const PUT = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, businessHashtagsInput);
    const hashtags = await putBusinessHashtags(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      tenant.userId,
      input,
    );
    audit(
      'studio.business.hashtags_update',
      { type: 'business', id: businessId },
      { custom: hashtags.custom, alwaysCount: hashtags.alwaysHashtags.length },
    );
    return { body: { hashtags } };
  },
);
