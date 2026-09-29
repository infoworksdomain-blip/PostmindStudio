import { requirePlatformStaff, StudioCapability } from '@/lib/rbac';
import { parseQuery, withStudioRoute } from '@/lib/studio/api/route';
import { listSubscriptions, subscriptionsQuery } from '@/lib/studio/services/admin-directory';

// GET /api/studio/admin/subscriptions?status=&offset= (Phase 18 §3 admin Subscriptions tab) —
// PostMind staff (studio:admin:billing): read-only list of Stripe subscriptions as Track C stores
// them (studio.subscriptions), counts per status, and the past-due grace deadline. Changes happen
// in Stripe or through the entitlement override (Track C).
export const GET = withStudioRoute(StudioCapability.AdminBilling, async ({ req, deps, tenant }) => {
  requirePlatformStaff(tenant);
  return { body: await listSubscriptions(deps.db, parseQuery(req, subscriptionsQuery)) };
});
