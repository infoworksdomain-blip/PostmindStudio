import { handleStripeWebhookRequest } from '@/lib/studio/billing/webhook-route';

// Phase 18 §2.7 — POST /api/billing/stripe/webhook (Stripe → Studio). Public, no tenant: the
// Stripe-Signature header is verified on the raw body (billing/webhook.ts). Outside /api/studio,
// so the tenant middleware and the Studio rate limiter never see it.
export const dynamic = 'force-dynamic';

export const POST = handleStripeWebhookRequest;
