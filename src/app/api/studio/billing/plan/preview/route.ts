import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { MAX_CHANNELS, MIN_CHANNELS } from '@/lib/studio/billing/channel-plan';

// Phase 21.5 Your plan — GET /api/studio/billing/plan/preview?channels=&interval=: the new price,
// when the change applies (now or at the end of the period) and, for a change that applies now,
// the prorated amount Stripe would invoice today (invoices.createPreview). Nothing is changed.
const query = z.object({
  channels: z.coerce.number().int().min(MIN_CHANNELS).max(MAX_CHANNELS),
  interval: z.enum(['week', 'month', 'year']),
});

export const GET = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const next = parseQuery(req, query);
    return { body: { preview: await deps.billing.previewPlanChange(tenant.organisationId, next) } };
  },
);
