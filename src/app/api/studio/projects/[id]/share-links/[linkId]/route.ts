import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { revokeShareLink } from '@/lib/studio/services/share-links';

// DELETE /api/studio/projects/:id/share-links/:linkId — BACKLOG 15.E5: revoke a share link at
// once (the public page then answers the same 404 as an unknown link). Idempotent.
export const DELETE = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ tenant, deps, params, audit }) => {
    const link = await revokeShareLink(deps, tenant, params.id ?? '', params.linkId ?? '');
    audit(
      'studio.share_link.revoke',
      { type: 'share_link', id: link.id },
      { projectId: params.id },
    );
    return { body: { link } };
  },
);
