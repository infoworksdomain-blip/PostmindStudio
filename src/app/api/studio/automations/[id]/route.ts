import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { automationDetail } from '@/lib/studio/services/automation-actions';
import {
  automationSummary,
  updateAutomation,
  updateAutomationInput,
} from '@/lib/studio/services/automations';
import { isCostViewer } from '@/lib/studio/services/cost-viewer';

// /api/studio/automations/:id (22.5) — GET the automation with its periods and slot calendar
// (format, angle, status and reason per slot; "download only" networks); PATCH a DRAFT.
export const GET = withStudioRoute(
  StudioCapability.ProjectRead,
  async ({ tenant, deps, params }) => ({
    body: await automationDetail(deps.db, tenant.organisationId, params.id ?? ''),
  }),
);

export const PATCH = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, params, audit }) => {
    const input = await parseBody(req, updateAutomationInput);
    const automation = await updateAutomation(deps, tenant, params.id ?? '', {
      ...input,
      ...(input.costCeilingPence !== undefined && {
        costCeilingPence: isCostViewer(tenant) ? input.costCeilingPence : undefined,
      }),
    });
    audit(
      'studio.automation.update',
      { type: 'automation', id: automation.id },
      {
        fields: Object.keys(input),
      },
    );
    return { body: { automation: automationSummary(automation) } };
  },
);
