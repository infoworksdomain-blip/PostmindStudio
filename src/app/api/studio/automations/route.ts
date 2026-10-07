import { StudioCapability } from '@/lib/rbac';
import { parseBody, parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { isCostViewer } from '@/lib/studio/services/cost-viewer';
import {
  automationSummary,
  createAutomation,
  createAutomationInput,
  listAutomations,
  listAutomationsQuery,
} from '@/lib/studio/services/automations';

// /api/studio/automations (22.5) — weekly / monthly auto generation and posting.
// GET ?businessId= lists them; POST creates a DRAFT (nothing runs until POST …/:id/start).
export const GET = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const query = parseQuery(req, listAutomationsQuery);
  const automations = await listAutomations(
    deps.db,
    tenant.organisationId,
    query,
    new Date(deps.now()),
  );
  return { body: { automations } };
});

export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, createAutomationInput);
    // The per-period cost ceiling is internal: only staff may set it.
    const automation = await createAutomation(deps, tenant, {
      ...input,
      costCeilingPence: isCostViewer(tenant) ? input.costCeilingPence : undefined,
    });
    audit(
      'studio.automation.create',
      { type: 'automation', id: automation.id },
      {
        businessId: automation.businessId,
        duration: automation.duration,
        approvalMode: automation.approvalMode,
        platforms: automation.platforms,
      },
    );
    return { status: 201, body: { automation: automationSummary(automation) } };
  },
);
