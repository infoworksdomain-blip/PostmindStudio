import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import {
  reschedulePublication,
  reschedulePublicationInput,
} from '@/lib/studio/services/publication-reschedule';
import { getPublication } from '@/lib/studio/services/publications';

// GET /api/studio/publications/:id — state and platform URL once published
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: { publication: await getPublication(deps.db, tenant.organisationId, params.id ?? '') },
  }),
);

// PATCH /api/studio/publications/:id { scheduledFor } — move a scheduled publication (calendar
// drag, BACKLOG 13.9). 409 unless SCHEDULED and not yet fired; 400 outside 1 minute – 180 days.
export const PATCH = withStudioRoute(
  StudioCapability.PublicationWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, reschedulePublicationInput);
    const { publication, previousScheduledFor } = await reschedulePublication(
      deps,
      tenant,
      params.id ?? '',
      input,
    );
    audit(
      'studio.publication.reschedule',
      { type: 'video_publication', id: publication.id },
      {
        from: previousScheduledFor?.toISOString() ?? null,
        to: publication.scheduledFor?.toISOString() ?? null,
      },
    );
    return { body: { publication } };
  },
);
