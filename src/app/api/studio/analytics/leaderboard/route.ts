import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { analyticsLeaderboard, leaderboardQuery } from '@/lib/studio/services/analytics';

// GET /api/studio/analytics/leaderboard?days=30&metric=views&limit=10 — top publications
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => ({
  body: await analyticsLeaderboard(
    deps.db,
    tenant.organisationId,
    parseQuery(req, leaderboardQuery),
    deps.now(),
  ),
}));
