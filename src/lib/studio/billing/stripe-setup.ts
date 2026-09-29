import type Stripe from 'stripe';
import {
  PLAN_CATALOGUE,
  REFERENCE_PRICES_PENCE,
  selfServeTiers,
  TOP_UP_PACKS,
  type BillingInterval,
} from './catalogue';

// Phase 18 §2.7 — what scripts/billing/seed-stripe-test.ts and portal-config.ts create in Stripe,
// as pure data (unit tested). Docs read 2026-09-29:
//   Products create (custom id, metadata, tax_code)  https://docs.stripe.com/api/products/create
//   Prices create (lookup_key, transfer_lookup_key,
//     tax_behavior, recurring.interval)              https://docs.stripe.com/api/prices/create
//   Product tax codes: SaaS business use txcd_10103001 https://docs.stripe.com/tax/tax-codes
//   Customer Portal configuration                     https://docs.stripe.com/api/customer_portal/configurations/create

/** SaaS, business use (Stripe product tax code). */
export const SAAS_TAX_CODE = 'txcd_10103001';
export const CURRENCY = 'gbp';

export interface ProductSpec {
  id: string;
  name: string;
  metadata: Record<string, string>;
}

export interface PriceSpec {
  productId: string;
  lookupKey: string;
  unitAmountPence: number;
  interval: BillingInterval | null;
}

const TIER_NAMES = { BASIC: 'Basic', STANDARD: 'Standard', PLUS: 'Plus', ENTERPRISE: 'Enterprise' };

export function productIdForTier(tier: keyof typeof TIER_NAMES): string {
  return `studio_${tier.toLowerCase()}`;
}

/** The 3 self-serve products + ENTERPRISE (no prices: staff quote it) + one per top-up pack. */
export function catalogueProducts(): ProductSpec[] {
  const plans = (['BASIC', 'STANDARD', 'PLUS', 'ENTERPRISE'] as const).map((tier) => ({
    id: productIdForTier(tier),
    name: `PostMind Studio ${TIER_NAMES[tier]}`,
    metadata: { studio_tier: tier, studio_catalogue: 'plan' },
  }));
  const packs = TOP_UP_PACKS.map((pack) => ({
    id: pack.lookupKey,
    name: `PostMind Studio top-up: ${pack.quantity} ${pack.kind} videos (${TIER_NAMES[pack.tier]})`,
    metadata: {
      studio_tier: pack.tier,
      studio_catalogue: 'topup',
      studio_topup_kind: pack.kind,
      studio_topup_quantity: String(pack.quantity),
    },
  }));
  return [...plans, ...packs];
}

/** The 6 recurring prices and 5 one-time top-up prices at the §P.2 amounts. */
export function cataloguePrices(): PriceSpec[] {
  const recurring = selfServeTiers().flatMap((tier) =>
    (Object.entries(PLAN_CATALOGUE[tier].lookupKeys) as [BillingInterval, string][]).map(
      ([interval, lookupKey]) => ({
        productId: productIdForTier(tier),
        lookupKey,
        unitAmountPence: requiredAmount(lookupKey),
        interval,
      }),
    ),
  );
  const oneTime = TOP_UP_PACKS.map((pack) => ({
    productId: pack.lookupKey,
    lookupKey: pack.lookupKey,
    unitAmountPence: requiredAmount(pack.lookupKey),
    interval: null,
  }));
  return [...recurring, ...oneTime];
}

function requiredAmount(lookupKey: string): number {
  const amount = REFERENCE_PRICES_PENCE[lookupKey];
  if (amount === undefined) throw new RangeError(`No §P.2 amount for ${lookupKey}`);
  return amount;
}

export function priceCreateParams(spec: PriceSpec): Stripe.PriceCreateParams {
  return {
    product: spec.productId,
    currency: CURRENCY,
    unit_amount: spec.unitAmountPence,
    lookup_key: spec.lookupKey,
    // Moves the key from an older price (a price change without a deploy, §2.7).
    transfer_lookup_key: true,
    tax_behavior: 'exclusive',
    ...(spec.interval && { recurring: { interval: spec.interval } }),
    metadata: { studio_lookup_key: spec.lookupKey },
  };
}

/** Does an existing Stripe price already match the spec (so the seed leaves it alone)? */
export function priceMatches(
  existing: {
    unitAmountPence: number | null;
    currency: string;
    interval: BillingInterval | null;
    active: boolean;
  },
  spec: PriceSpec,
): boolean {
  return (
    existing.active &&
    existing.currency === CURRENCY &&
    existing.unitAmountPence === spec.unitAmountPence &&
    existing.interval === spec.interval
  );
}

/**
 * §2.7 portal: payment methods, invoices and tax ids; plan switching among the 3 self-serve
 * products (upgrades invoiced at once, downgrades and interval shortening at period end); cancel
 * at period end with a reason survey.
 */
export function portalConfigurationParams(input: {
  appUrl: string;
  products: Array<{ productId: string; priceIds: string[] }>;
}): Stripe.BillingPortal.ConfigurationCreateParams {
  const url = (path: string) => new URL(path, input.appUrl).toString();
  return {
    name: 'PostMind Studio',
    business_profile: {
      privacy_policy_url: url('/legal/privacy'),
      terms_of_service_url: url('/legal/terms'),
    },
    default_return_url: url('/settings/billing'),
    features: {
      customer_update: { enabled: true, allowed_updates: ['address', 'name', 'email', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: {
          enabled: true,
          options: [
            'too_expensive',
            'missing_features',
            'switched_service',
            'unused',
            'low_quality',
            'too_complex',
            'customer_service',
            'other',
          ],
        },
      },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'always_invoice',
        schedule_at_period_end: {
          conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }],
        },
        products: input.products.map((p) => ({ product: p.productId, prices: p.priceIds })),
      },
    },
  };
}
