import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { defaultsQuery, planDefaults } from '@/lib/studio/services/content-plans';

// GET /api/studio/content-plans/defaults?businessId=&timezone= (20.9) — the form's starting
// values: next free day, 30 days, posts a day from the posting times (or 1), the allowance left
// this month (top-up credits included) and the monthly cost headroom.
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, defaultsQuery);
  return { body: { defaults: await planDefaults(deps, tenant, query) } };
});
