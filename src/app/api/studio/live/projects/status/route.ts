import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { liveSnapshots, statusQuery } from '@/lib/studio/live/snapshot';

// GET /api/studio/live/projects/status?ids=a,b (24.2) — the current live status of up to 100 of
// the organisation's projects (the starting point the SSE stream then updates). Ids of other
// organisations' projects are simply absent.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const { ids } = parseQuery(req, statusQuery);
  return { body: { projects: await liveSnapshots(deps, tenant.organisationId, ids) } };
});
