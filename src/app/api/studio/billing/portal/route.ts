import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseBody, withStudioRoute } from '@/lib/studio/api/route';

// Phase 18 §2.7 — POST /api/studio/billing/portal → { url } of a Stripe Customer Portal session
// (payment methods, invoices, tax ids, plan change, cancel at period end). returnPath must be a
// relative in-app path (no open redirect); default /settings/billing.
const portalInput = z.object({ returnPath: z.string().trim().max(200).optional() }).strict();

export const POST = withStudioRoute(
  StudioCapability.BillingManage,
  async ({ req, deps, tenant }) => {
    if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
    const input = await parseBody(req, portalInput);
    const { url } = await deps.billing.createPortal(
      tenant.organisationId,
      input.returnPath ?? '/settings/billing',
    );
    return { body: { url } };
  },
);
