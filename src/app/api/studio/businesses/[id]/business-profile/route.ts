import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { autoRefreshStock } from '@/lib/studio/services/image-library';
import {
  getBusinessProfile,
  patchBusinessProfile,
  patchBusinessProfileInput,
} from '@/lib/studio/services/scans';

// GET|PATCH /api/studio/businesses/:id/business-profile — LLM classification + user edits (A6.8)
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: {
      profile: await getBusinessProfile(deps.db, tenant.organisationId, parseBusinessId(params.id)),
    },
  }),
);

export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, patchBusinessProfileInput);
    const profile = await patchBusinessProfile(deps.db, tenant.organisationId, businessId, input);
    // 20.26: top up a thin image library with stock photos for the saved profile (never fails
    // the save; cheap, rate-limited and cached: services/image-library.ts autoRefreshStock).
    const stockRefresh = await autoRefreshStock(deps, tenant, {
      businessId,
      changedFields: Object.keys(input),
    });
    audit(
      'studio.business_profile.update',
      { type: 'business_profile', id: profile.id },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { profile, stockRefresh } };
  },
);
