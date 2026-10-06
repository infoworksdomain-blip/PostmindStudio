import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { decideSlot, slotDecisionInput } from '@/lib/studio/services/automation-actions';
import { toPlanTier } from '@/lib/studio/services/catalog';
import { routedPlanGenerator } from '@/lib/studio/services/content-plan-draft';

// POST /api/studio/automations/:id/slots/:itemId (22.5) — review one slot of a period in REVIEW
// ("Review in Blitz first"): { action: keep | skip | reroll }. Nothing is generated or charged
// until the period is approved.
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const { action } = await parseBody(req, slotDecisionInput);
    const detail = await decideSlot(
      {
        ...deps,
        generate: routedPlanGenerator(deps.library.providers, {
          organisationId: tenant.organisationId,
          planTier: toPlanTier(tenant.organisation.planTier),
        }),
      },
      tenant.organisationId,
      params.id ?? '',
      params.itemId ?? '',
      action,
    );
    audit(
      'studio.automation.slot',
      { type: 'automation', id: params.id ?? '' },
      {
        itemId: params.itemId,
        action,
      },
    );
    return { body: detail };
  },
);
