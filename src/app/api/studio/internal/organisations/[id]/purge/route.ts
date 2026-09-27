import { withInternalRoute } from '@/lib/studio/api/internal';
import { purgeOrganisation } from '@/lib/studio/services/organisation-purge';

// Internal (X-Service-Token; bind to private ingress) — BACKLOG 13.22, spec 8.x internal API,
// mirroring Engagement 14.13. POST /api/studio/internal/organisations/:id/purge — PostMind Core
// calls it when an organisation is deleted: tokens are wiped and channels disconnected at once,
// the workspace kill switch is engaged, scheduled posts are cancelled, and Studio data is
// soft-deleted with a 30-day grace period. No body. Idempotent. 202 { purge }. Audited as
// studio.organisation.purge (system:postmind-core); no token is ever logged or returned.
export const POST = withInternalRoute(async ({ deps, params, audit }) => {
  const purge = await purgeOrganisation(deps, params.id ?? '');
  audit(
    purge.organisationId,
    'studio.organisation.purge',
    { type: 'organisation', id: purge.organisationId },
    {
      channelsWiped: purge.channelsWiped,
      projectsDeleted: purge.projectsDeleted,
      publicationsCancelled: purge.publicationsCancelled,
      graceUntil: purge.graceUntil,
      repeated: purge.repeated,
    },
  );
  return { status: 202, body: { purge } };
});
