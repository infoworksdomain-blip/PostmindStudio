import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { businessIdParam } from '@/lib/studio/services/businesses';
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
      profile: await getBusinessProfile(
        deps.db,
        tenant.organisationId,
        businessIdParam.parse(params.id),
      ),
    },
  }),
);

export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = businessIdParam.parse(params.id);
    const input = await parseBody(req, patchBusinessProfileInput);
    const profile = await patchBusinessProfile(deps.db, tenant.organisationId, businessId, input);
    audit(
      'studio.business_profile.update',
      { type: 'business_profile', id: profile.id },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { profile } };
  },
);
