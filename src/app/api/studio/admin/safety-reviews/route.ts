import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listSafetyReviews, listSafetyReviewsQuery } from '@/lib/studio/services/safety-reviews';

// GET /api/studio/admin/safety-reviews?state=PENDING|ALLOWED|BLOCKED&limit&cursor — BACKLOG 13.17
// / spec 16.4 content-safety review queue across every organisation (pending: oldest first).
// Content reviews carry a signed preview URL of the first flagged render; script reviews carry
// script excerpts. PostMind staff with studio:admin:moderation only.
export const GET = withStudioRoute(
  StudioCapability.AdminModeration,
  async ({ req, deps, tenant }) => {
    requirePlatformStaff(tenant);
    const query = parseQuery(req, listSafetyReviewsQuery);
    return { body: await listSafetyReviews(deps, query) };
  },
);
