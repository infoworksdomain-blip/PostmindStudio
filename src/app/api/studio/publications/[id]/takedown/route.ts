import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { takedownPublication } from '@/lib/studio/services/publications';

// POST /api/studio/publications/:id/takedown — delete from the platform where its API allows
export const POST = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ tenant, deps, params, audit }) => {
    const publication = await takedownPublication(
      deps.publishing,
      tenant.organisationId,
      params.id ?? '',
    );
    audit('studio.publication.takedown', { type: 'video_publication', id: publication.id });
    return { body: { publication } };
  },
);
