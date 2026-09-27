import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { cancelPublication } from '@/lib/studio/services/publications';

// POST /api/studio/publications/:id/cancel — cancel a scheduled publication before it fires
export const POST = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ tenant, deps, params, audit }) => {
    const publication = await cancelPublication(deps.db, tenant.organisationId, params.id ?? '');
    audit('studio.publication.cancel', { type: 'video_publication', id: publication.id });
    return { body: { publication } };
  },
);
