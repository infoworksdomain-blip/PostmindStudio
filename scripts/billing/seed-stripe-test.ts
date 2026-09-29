import type Stripe from 'stripe';
import { ConfigurationError } from '../../src/lib/errors';
import { logger } from '../../src/lib/logger';
import { toPriceState } from '../../src/lib/studio/billing/gateway';
import {
  catalogueProducts,
  cataloguePrices,
  priceCreateParams,
  priceMatches,
  SAAS_TAX_CODE,
  type ProductSpec,
} from '../../src/lib/studio/billing/stripe-setup';
import { createStripeClient, isTestModeKey } from '../../src/lib/studio/billing/stripe-client';

// Phase 18 §2.7 / §P.2 — create the Studio catalogue in a Stripe TEST-mode account:
//   4 products (studio_basic / _standard / _plus / _enterprise, metadata studio_tier, tax code
//   SaaS business use), 6 recurring GBP prices with lookup keys studio_<tier>_<monthly|yearly>,
//   5 top-up products with one-time prices studio_topup_*; all tax_behavior=exclusive, amounts
//   from §P.2 (catalogue REFERENCE_PRICES_PENCE).
//
//   STRIPE_SECRET_KEY=sk_test_… npx tsx scripts/billing/seed-stripe-test.ts [--dry-run]
//
// Idempotent: an existing product is left alone; a lookup key whose active price already has the
// right amount, currency and interval is left alone; otherwise a new price is created with
// transfer_lookup_key=true (the key moves; the old price keeps its subscribers). Refuses live keys:
// in live mode the operator creates prices in the dashboard (runbooks/billing-stripe.md).

async function ensureProduct(stripe: Stripe, spec: ProductSpec, dryRun: boolean) {
  try {
    const existing = await stripe.products.retrieve(spec.id);
    logger.info({ product: spec.id, active: existing.active }, 'product exists');
    return;
  } catch (err) {
    if ((err as { code?: string }).code !== 'resource_missing') throw err;
  }
  if (dryRun) {
    logger.info({ product: spec.id }, '[dry-run] would create product');
    return;
  }
  await stripe.products.create({
    id: spec.id,
    name: spec.name,
    metadata: spec.metadata,
    tax_code: SAAS_TAX_CODE,
  });
  logger.info({ product: spec.id }, 'product created');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new ConfigurationError('STRIPE_SECRET_KEY is not set');
  if (!isTestModeKey(key))
    throw new ConfigurationError('Refusing to seed: STRIPE_SECRET_KEY is not a test-mode key');
  const stripe = createStripeClient(key);
  for (const product of catalogueProducts()) await ensureProduct(stripe, product, dryRun);
  const specs = cataloguePrices();
  const existing = await stripe.prices.list({
    lookup_keys: specs.map((s) => s.lookupKey),
    limit: 100,
    expand: ['data.product'],
  });
  const byKey = new Map(existing.data.map((p) => [p.lookup_key ?? '', toPriceState(p)]));
  let created = 0;
  for (const spec of specs) {
    const current = byKey.get(spec.lookupKey);
    if (current && priceMatches(current, spec)) {
      logger.info({ lookupKey: spec.lookupKey, price: current.id }, 'price up to date');
      continue;
    }
    if (dryRun) {
      logger.info(
        { lookupKey: spec.lookupKey, amount: spec.unitAmountPence },
        '[dry-run] would create price',
      );
      continue;
    }
    const price = await stripe.prices.create(priceCreateParams(spec));
    created += 1;
    logger.info(
      { lookupKey: spec.lookupKey, price: price.id, amount: spec.unitAmountPence },
      'price created',
    );
  }
  logger.info({ created, dryRun }, 'stripe test catalogue seeded');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'seed-stripe-test failed');
  process.exit(1);
});
