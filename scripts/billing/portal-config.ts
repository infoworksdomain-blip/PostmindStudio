import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { selfServeTiers } from '../../src/lib/studio/billing/catalogue';
import { createStripeClient } from '../../src/lib/studio/billing/stripe-client';
import { listPricesByLookupKeys } from '../../src/lib/studio/billing/stripe-lookup';
import {
  cataloguePrices,
  portalConfigurationParams,
  productIdForTier,
} from '../../src/lib/studio/billing/stripe-setup';

// Phase 18 §2.7 — create (or update) the Stripe Customer Portal configuration Studio uses:
// payment methods, invoices and tax ids; plan switching among the 3 self-serve products
// (upgrades invoiced at once — proration always_invoice; downgrades and shorter intervals at the
// end of the period); cancel at period end with a reason survey.
//
//   STRIPE_SECRET_KEY=… APP_URL=https://studio.example.com npx tsx scripts/billing/portal-config.ts
//     [--update <bpc_…>]   (default: STRIPE_PORTAL_CONFIGURATION_ID if set, else create)
//
// Prints the configuration id: put it in STRIPE_PORTAL_CONFIGURATION_ID. Works in test and live
// mode (run once per mode). Prices are looked up by the catalogue's lookup keys, so run
// seed-stripe-test.ts (test) or create the prices (live) first.
// https://docs.stripe.com/api/customer_portal/configurations/create (read 2026-09-29)

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const appUrl = process.env.APP_URL?.trim();
  if (!key) throw new ConfigurationError('STRIPE_SECRET_KEY is not set');
  if (!appUrl) throw new ConfigurationError('APP_URL is not set');
  const flag = process.argv.indexOf('--update');
  const updateId =
    (flag >= 0 ? process.argv[flag + 1] : undefined) ??
    process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() ??
    undefined;
  const stripe = createStripeClient(key);
  const recurring = cataloguePrices().filter((p) => p.interval !== null);
  const prices = await listPricesByLookupKeys(
    stripe.prices,
    recurring.map((p) => p.lookupKey),
    { active: true },
  );
  const products = selfServeTiers().map((tier) => {
    const productId = productIdForTier(tier);
    const keys = new Set(
      recurring.filter((p) => p.productId === productId).map((p) => p.lookupKey),
    );
    const priceIds = prices.filter((p) => keys.has(p.lookup_key ?? '')).map((p) => p.id);
    if (priceIds.length !== keys.size)
      throw new ConfigurationError(
        `Missing prices for ${productId}: expected lookup keys ${[...keys].join(', ')}`,
      );
    const product = prices.find((p) => keys.has(p.lookup_key ?? ''))?.product;
    return {
      productId: typeof product === 'string' ? product : (product?.id ?? productId),
      priceIds,
    };
  });
  const params = portalConfigurationParams({ appUrl, products });
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
