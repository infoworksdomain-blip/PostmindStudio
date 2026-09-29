import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { adminSubscriptionsQuery, listAdminSubscriptions } from '@/lib/studio/billing/admin';

// Phase 18 §P.4 — GET /api/studio/admin/billing/subscriptions?status=&limit= (staff): stored
// Stripe subscriptions (newest first) with each one's MRR, and the summary: total MRR (active +
// past_due, annual ÷ 12, ex-VAT), counts by status and by tier.
export const GET = withStudioRoute(StudioCapability.AdminBilling, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  const query = parseQuery(req, adminSubscriptionsQuery);
  return { body: await listAdminSubscriptions(deps.db, query) };
});
