import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { publicAngle, suggestAngles, suggestAnglesInput } from '@/lib/studio/services/angles';
import { parseBusinessId } from '@/lib/studio/services/businesses';
import { toPlanTier } from '@/lib/studio/services/catalog';
import { routedPlanGenerator } from '@/lib/studio/services/content-plan-draft';

// POST /api/studio/businesses/:id/angles/suggest (22.4) — Claude suggests new angles from the
// business profile, never repeating an existing title; they are saved (source "ai").
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const businessId = parseBusinessId(params.id);
    const { count } = await parseBody(req, suggestAnglesInput);
    const angles = await suggestAngles(
      {
        db: deps.db,
        now: deps.now,
        generate: routedPlanGenerator(deps.library.providers, {
          organisationId: tenant.organisationId,
          planTier: toPlanTier(tenant.organisation.planTier),
        }),
      },
      { organisationId: tenant.organisationId, businessId },
      tenant.userId,
      count,
    );
    audit('studio.angle.suggest', { type: 'business', id: businessId }, { created: angles.length });
    return { status: 201, body: { angles: angles.map(publicAngle) } };
  },
);
