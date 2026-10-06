import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { estimateAutomation, estimateInput } from '@/lib/studio/services/automation-actions';
import { isCostViewer } from '@/lib/studio/services/cost-viewer';

// POST /api/studio/automations/estimate (22.5) — the wizard's summary: posts per period and the
// format split of the business's mix (cheapest first). Customers never see pence; staff get the
// typical provider cost too.
export const POST = withStudioRoute(StudioCapability.ProjectRead, async ({ req, tenant, deps }) => {
  const input = await parseBody(req, estimateInput);
  const { estimatePence, ...estimate } = await estimateAutomation(deps, tenant, input);
  return {
    body: { estimate: isCostViewer(tenant) ? { ...estimate, estimatePence } : estimate },
  };
});
