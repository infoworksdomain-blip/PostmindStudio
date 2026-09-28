import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { computeProviderRatings } from '@/lib/studio/services/provider-ratings';

// GET /api/studio/businesses/:id/provider-ratings — P7 (Addendum A3.6 step 3): how this
// business's provider ratings were computed (approval rate, regeneration rate, retention) and
// the score the router uses to prefer providers within a tier's candidates. Read-only.
// Tenant-scoped: only this organisation's projects for the business are read.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const ratings = await computeProviderRatings(deps.db, {
      organisationId: tenant.organisationId,
      businessId: parseBusinessId(params.id),
      now: deps.now(),
    });
    return { body: { scores: ratings } };
  },
);
