import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import {
  createPublication,
  createPublicationInput,
  listPublications,
  listPublicationsQuery,
} from '@/lib/studio/services/publications';

// POST /api/studio/publications — publish a render now or schedule it (spec 8.4, 9.9)
export const POST = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createPublicationInput);
    const publication = await createPublication(deps, tenant, input);
    audit(
      input.scheduledFor ? 'studio.publication.schedule' : 'studio.publication.publish',
      { type: 'video_publication', id: publication.id },
      {
        platform: input.platform,
        renderId: input.renderId,
        scheduledFor: input.scheduledFor ?? null,
      },
    );
    return { status: 202, body: { publication } };
  },
);

// GET /api/studio/publications — list for the manage screen and calendar (spec 8.4, 14.3)
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: await listPublications(
    deps.db,
    tenant.organisationId,
    parseQuery(req, listPublicationsQuery),
  ),
}));
