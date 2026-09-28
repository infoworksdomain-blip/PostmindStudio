import { parseInternalBody, withInternalRoute } from '@/lib/studio/api/internal';
import { businessPurgeInput, purgeBusiness } from '@/lib/studio/services/business-purge';

// Internal (X-Service-Token; bind to private ingress) — BACKLOG 15.E2, spec 7.14 / 16.2
// business.deleted, A11.7. POST /api/studio/internal/businesses/:id/purge { organisationId }
// PostMind Core calls it when a business is deleted: projects soft-deleted and stopped, scheduled
// posts cancelled, style memories wiped, business-scoped tokens wiped; everything is hard-deleted
// after the 30-day grace by the retention sweep. Idempotent. 202 { purge }. Audited as
// studio.business.purge (system:postmind-core); no token is logged or returned.
export const POST = withInternalRoute(async ({ req, deps, params, audit }) => {
  const { organisationId } = await parseInternalBody(req, businessPurgeInput);
  const purge = await purgeBusiness(deps, { organisationId, businessId: params.id ?? '' });
  audit(
    purge.organisationId,
    'studio.business.purge',
    { type: 'business', id: purge.businessId },
    {
      projectsDeleted: purge.projectsDeleted,
      publicationsCancelled: purge.publicationsCancelled,
      styleMemoriesDeleted: purge.styleMemoriesDeleted,
      channelsWiped: purge.channelsWiped,
      graceUntil: purge.graceUntil,
      repeated: purge.repeated,
    },
  );
  return { status: 202, body: { purge } };
});
