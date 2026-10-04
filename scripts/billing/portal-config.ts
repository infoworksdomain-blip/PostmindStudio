import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { createStripeClient } from '../../src/lib/studio/billing/stripe-client';
import { portalConfigurationParams } from '../../src/lib/studio/billing/stripe-setup';

// Phase 18 §2.7 / 21.5 — create (or update) the Stripe Customer Portal configuration Studio uses:
// payment methods, invoices, billing details and tax ids ONLY. Changing channels or the billing
// interval, cancelling and resuming happen on Studio's "Your plan" page (/settings/billing), so
// the portal's subscription update and cancel features are turned off.
//
//   STRIPE_SECRET_KEY=… APP_URL=https://studio.example.com npx tsx scripts/billing/portal-config.ts
//     [--update <bpc_…>]   (default: STRIPE_PORTAL_CONFIGURATION_ID if set, else create)
//
// Prints the configuration id: put it in STRIPE_PORTAL_CONFIGURATION_ID. Works in test and live
// mode (run once per mode). Re-run it with --update after upgrading to 21.5 so an existing
// configuration stops offering the old tier switching.
// https://docs.stripe.com/api/customer_portal/configurations/create (read 2026-09-29, 2026-10-04)

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const appUrl = process.env.APP_URL?.trim();
  if (!key) throw new ConfigurationError('STRIPE_SECRET_KEY is not set');
  if (!appUrl) throw new ConfigurationError('APP_URL is not set');
  const flag = process.argv.indexOf('--update');
  const updateId =
    (flag >= 0 ? process.argv[flag + 1] : undefined) ??
    (process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() || undefined);
  const stripe = createStripeClient(key);
  const params = portalConfigurationParams({ appUrl });
  const config = updateId
    ? await stripe.billingPortal.configurations.update(updateId, params)
    : await stripe.billingPortal.configurations.create(params);
  logger.info(
    { id: config.id, updated: Boolean(updateId) },
    `portal configuration ready: set STRIPE_PORTAL_CONFIGURATION_ID=${config.id}`,
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'portal-config failed');
  process.exit(1);
});
