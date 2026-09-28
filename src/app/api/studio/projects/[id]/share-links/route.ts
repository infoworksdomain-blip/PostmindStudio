import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  createShareLink,
  createShareLinkInput,
  listShareLinks,
} from '@/lib/studio/services/share-links';

// BACKLOG 15.E5 — smart-preview share links (spec 4.4; operator decision P8: external reviewers
// view and leave feedback, never approve).
//   GET  /api/studio/projects/:id/share-links → { data: [{ id, state, expiresAt, comments[] }] }
//   POST /api/studio/projects/:id/share-links { expiresInHours ≤ 168 } → 201 { link: { id, url } }
// The URL (with its token) is returned once; only the token's SHA-256 is stored.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      data: await listShareLinks(deps.db, tenant.organisationId, params.id ?? '', deps.now()),
    },
  }),
);

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, createShareLinkInput);
    const link = await createShareLink(deps, tenant, params.id ?? '', input);
    audit(
      'studio.share_link.create',
      { type: 'share_link', id: link.id },
      { projectId: params.id, expiresAt: link.expiresAt },
    );
    return { status: 201, body: { link } };
  },
);
