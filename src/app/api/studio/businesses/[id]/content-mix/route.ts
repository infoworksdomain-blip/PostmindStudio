import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { getMix, mixInput, publicMix, putMix } from '@/lib/studio/services/content-mix';

// /api/studio/businesses/:id/content-mix (22.4) — format weights (paid formats default 0),
// remix %, mention-business %, caption-style weights and creator chance, plus the bounded nudges
// swipes made (resetAdjustments clears them). Automations snapshot this when they start.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => {
    const scope = { organisationId: tenant.organisationId, businessId: parseBusinessId(params.id) };
    return { body: { mix: publicMix(await getMix(deps.db, scope)) } };
  },
);

export const PUT = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const input = await parseBody(req, mixInput);
    const mix = await putMix(
      deps.db,
      { organisationId: tenant.organisationId, businessId },
      tenant.userId,
      input,
    );
    audit(
      'studio.content_mix.update',
      { type: 'business', id: businessId },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { mix: publicMix(mix) } };
  },
);
