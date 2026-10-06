import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listDemoVideos, listDemoVideosQuery } from '@/lib/studio/services/demo-videos';

// GET /api/studio/uploads/demo-videos?businessId=… — 22.1: the business's demo-video bank (READY
// demo_video uploads, newest first) for Create → "Hook + demo".
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listDemoVideosQuery);
  return { body: await listDemoVideos(deps.db, tenant.organisationId, query) };
});
