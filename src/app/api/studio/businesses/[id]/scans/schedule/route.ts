import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { getScanSchedule } from '@/lib/studio/scan/schedule';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// GET /api/studio/businesses/:id/scans/schedule — next scheduled rescan and stock refresh, and
// the last time a rescan was skipped because the site was unchanged (A6.6, BACKLOG 13.10).
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await getScanSchedule(
      deps.db,
      { organisationId: tenant.organisationId, businessId: parseBusinessId(params.id) },
      deps.now(),
    ),
  }),
);
