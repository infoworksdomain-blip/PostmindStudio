import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { retryPublication } from '@/lib/studio/services/publications';

// POST /api/studio/publications/:id/retry — retry a failed publication
export const POST = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ tenant, deps, params, audit }) => {
    const publication = await retryPublication(deps, tenant, params.id ?? '');
    audit('studio.publication.retry', { type: 'video_publication', id: publication.id });
    return { status: 202, body: { publication } };
  },
);
