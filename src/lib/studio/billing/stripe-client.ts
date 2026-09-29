import Stripe from 'stripe';
import { ConfigurationError } from '../../errors';

// Phase 18 §2.7 — the one place Studio constructs a Stripe client.
//
// Research (read 2026-09-29):
//   - stripe-node 22.6.2 (npm, released 2026-09-09) pins API version 2026-08-26.dahlia
//     (node_modules/stripe/esm/apiVersion.js; CHANGELOG "22.6.0 … changes the pinned API version
//     to 2026-08-26.dahlia"). https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md
//   - Versioning: https://docs.stripe.com/api/versioning and the Dahlia changelog
//     https://docs.stripe.com/changelog/dahlia (no breaking change to the subscription, invoice,
//     checkout or portal fields Studio reads).
//   - Since Basil (2025-03-31) the billing period lives on subscription ITEMS
//     (items.data[].current_period_start/end), and an invoice's subscription is at
//     invoice.parent.subscription_details.subscription (types in
//     node_modules/stripe/esm/resources/{Subscriptions,SubscriptionItems,Invoices}.d.ts).
//
// The version is pinned explicitly (not left to the account default) so a dashboard upgrade can
// never change the shapes Studio parses. Upgrading = bump the package, re-read the changelog,
// change STRIPE_API_VERSION, and set the webhook endpoint's API version to match.

export const STRIPE_API_VERSION = '2026-08-26.dahlia' as const;

/** Network retries for idempotent-safe calls (the SDK adds Idempotency-Key to retried POSTs). */
const MAX_NETWORK_RETRIES = 2;
const TIMEOUT_MS = 20_000;

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: MAX_NETWORK_RETRIES,
    timeout: TIMEOUT_MS,
    appInfo: { name: 'PostMind Studio' },
  });
}

let cached: { key: string; client: Stripe } | undefined;

/** The process-wide client from STRIPE_SECRET_KEY. Throws when the key is missing. */
export function stripeFromEnv(env: Record<string, string | undefined> = process.env): Stripe {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new ConfigurationError('STRIPE_SECRET_KEY is not set');
  if (!cached || cached.key !== key) cached = { key, client: createStripeClient(key) };
  return cached.client;
}

/** Test mode keys start sk_test_ / rk_test_; scripts refuse to seed a live account. */
export function isTestModeKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key.trim());
}
