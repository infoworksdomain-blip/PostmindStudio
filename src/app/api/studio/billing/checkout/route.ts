import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';
import { MAX_CHANNELS, MIN_CHANNELS } from '@/lib/studio/billing/channel-plan';

// Phase 18 §2.7 / 21.5 — POST /api/studio/billing/checkout → { url } of a Stripe Checkout session:
//   { kind: 'channels', channels: 1–6, interval: week|month|year }  (per-channel plan; trial once)
//   { kind: 'topup', lookupKey: studio_pack_hd5 | studio_pack_hd15 } (one-off HD video pack)
// Owner only (studio:billing:manage). The browser is sent to the returned URL. An organisation
// that already has a live subscription gets 409 and changes it on Your plan instead.
const checkoutInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('channels'),
      channels: z.number().int().min(MIN_CHANNELS).max(MAX_CHANNELS),
      interval: z.enum(['week', 'month', 'year']),
      locale: z.string().trim().max(16).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('topup'),
      lookupKey: z
        .string()
        .trim()
        .regex(/^studio_pack_[a-z0-9_]+$/)
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
        input.kind === 'channels'
          ? { kind: 'channels', channels: input.channels, interval: input.interval }
          : { kind: 'topup', lookupKey: input.lookupKey },
      locale: input.locale ?? 'en-GB',
    });
    return { body: { url } };
  },
);
