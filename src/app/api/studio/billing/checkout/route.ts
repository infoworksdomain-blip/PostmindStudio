import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';

// Phase 18 §2.7 — POST /api/studio/billing/checkout → { url } of a Stripe Checkout session:
//   { kind: 'subscription', tier: BASIC|STANDARD|PLUS, interval: month|year }  (trial once)
//   { kind: 'topup', lookupKey }                                              (one-time pack)
// Owner only (studio:billing:manage). The browser is sent to the returned URL.
const checkoutInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('subscription'),
      tier: z.enum(['BASIC', 'STANDARD', 'PLUS']),
      interval: z.enum(['month', 'year']),
      locale: z.string().trim().max(16).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('topup'),
      lookupKey: z
        .string()
        .trim()
        .regex(/^studio_topup_[a-z0-9_]+$/)
        .max(64),
      locale: z.string().trim().max(16).optional(),
    })
    .strict(),
]);

export const POST = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const input = await parseBody(req, checkoutInput);
    const { url } = await deps.billing.createCheckout({
      organisationId: tenant.organisationId,
      userId: tenant.userId,
      intent:
        input.kind === 'subscription'
          ? { kind: 'subscription', tier: input.tier, interval: input.interval }
          : { kind: 'topup', lookupKey: input.lookupKey },
      locale: input.locale ?? 'en-GB',
    });
    return { body: { url } };
  },
);
