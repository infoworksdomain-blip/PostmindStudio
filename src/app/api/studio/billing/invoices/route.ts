import { z } from 'zod';
import { NotImplementedError } from '@/lib/errors';
import { StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';

// Phase 18 §3 — GET /api/studio/billing/invoices?limit=: the organisation's Stripe invoices
// (hosted page and PDF links).
const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) });

export const GET = withStudioRoute(StudioCapability.BillingRead, async ({ req, deps, tenant }) => {
  if (!deps.billing) throw new NotImplementedError('Stripe billing is not configured');
  const { limit } = parseQuery(req, query);
  return { body: { invoices: await deps.billing.listInvoices(tenant.organisationId, limit) } };
});
