import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { refillInput, refillNow } from '@/lib/studio/services/blitz';
import { parseBusinessId } from '@/lib/studio/services/businesses';

// POST /api/studio/blitz/refill (22.4) — "Generate more": queue a refill now (debounced per
// business; the daily render cap and the monthly render spend cap still apply in the job).
export const POST = withStudioRoute(
  StudioCapability.ProjectWrite,
  async ({ req, tenant, deps, audit }) => {
    const input = await parseBody(req, refillInput);
    const businessId = parseBusinessId(input.businessId);
    await refillNow(deps, tenant, businessId);
    audit('studio.blitz.refill', { type: 'business', id: businessId });
    return { status: 202, body: { queued: true } };
  },
);
