import { LiveEventsUnavailableError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { liveSnapshot } from '@/lib/studio/live/snapshot';
import { liveProjectStream, SSE_HEADERS } from '@/lib/studio/live/sse';

// GET /api/studio/live/projects (24.2) — Server-Sent Events: one `project` event (status, stage,
// progress %, ETA, thumbnail) each time a project of the signed-in member's organisation changes.
// The organisation comes from the session (requireTenantContext via withStudioRoute), never from
// the request: the stream subscribes to that organisation's channel only, and every event is
// re-read from the database scoped to it. Heartbeat every 25 s; closes on abort.

export const dynamic = 'force-dynamic';

export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const bus = deps.liveEvents;
  if (!bus) throw new LiveEventsUnavailableError('Live status is not available');
  const organisationId = tenant.organisationId;
  const stream = liveProjectStream({
    bus,
    organisationId,
    signal: req.signal,
    snapshot: (projectId) => liveSnapshot(deps, organisationId, projectId),
    logger: deps.logger.child({ organisationId, route: 'live/projects' }),
  });
  return { body: {}, raw: new Response(stream, { status: 200, headers: { ...SSE_HEADERS } }) };
});
