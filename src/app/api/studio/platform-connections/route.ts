import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { listConnections } from '@/lib/studio/services/connections';

// GET /api/studio/platform-connections — connected TikTok / YouTube / X / LinkedIn accounts
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ tenant, deps }) => ({
  body: { data: await listConnections(deps.db, tenant.organisationId) },
}));
