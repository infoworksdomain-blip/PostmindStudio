import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { bestTimes, bestTimesQuery } from '@/lib/studio/analytics/best-times';

// GET /api/studio/analytics/best-times?businessId=&platform=&language=&timezone= (15.A6, spec
// 9.9 advisory best-hour suggestions) → 200 { data: [{ weekday, hour, score, basis }],
// bestPerDay: [...], sufficientData, videos, styleMemory, advisory: true }
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, bestTimesQuery);
  return { body: await bestTimes(deps.db, tenant.organisationId, query, deps.now()) };
});
