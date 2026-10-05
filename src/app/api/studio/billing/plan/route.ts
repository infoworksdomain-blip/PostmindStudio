import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { MAX_CHANNELS, MIN_CHANNELS } from '@/lib/studio/billing/channel-plan';

// Phase 21.5 Your plan — POST /api/studio/billing/plan { channels, interval, prorationDate? }:
// change the number of channels (1–6) and / or the billing interval. Upgrades (more channels, a
// longer interval) apply now with proration, invoiced at once; downgrades (fewer channels, a
// shorter interval) at the end of the current period. prorationDate comes from the preview the
// customer confirmed, so Stripe charges exactly what was shown. Owner only.
//   → { outcome: { status: 'applied' | 'scheduled' | 'payment_required', timing, effectiveAt? } }
const changeInput = z
  .object({
    channels: z.number().int().min(MIN_CHANNELS).max(MAX_CHANNELS),
    interval: z.enum(['week', 'month', 'year']),
    prorationDate: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const POST = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const input = await parseBody(req, changeInput);
    const outcome = await deps.billing.changePlan({
      organisationId: tenant.organisationId,
      userId: tenant.userId,
      next: { channels: input.channels, interval: input.interval },
      prorationDate: input.prorationDate ?? null,
    });
    return { body: { outcome } };
  },
);
