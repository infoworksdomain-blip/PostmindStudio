import { StudioCapability } from '@/lib/rbac';
import { withStudioRoute } from '@/lib/studio/api/route';
import { pricingSourceFromEnv } from '@/lib/studio/billing/wiring';

// Phase 18 §P.4 — GET /api/studio/billing/plans: the plan catalogue with prices read from Stripe
// by lookup key (10-minute cache), for the in-app upgrade dialog and plan picker.
export const GET = withStudioRoute(StudioCapability.BillingRead, async ({ deps }) => ({
  body: { pricing: await pricingSourceFromEnv(deps.logger).get() },
}));
