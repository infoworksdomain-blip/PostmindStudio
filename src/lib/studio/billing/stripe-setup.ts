import type Stripe from 'stripe';
import { REFERENCE_PRICES_PENCE, TOP_UP_PACKS } from './catalogue';
import {
  PLAN_IDS,
  PLAN_INTERVALS,
  PLAN_NAMES,
  PLAN_TIER,
  planLookupKey,
  planProductId,
  type PlanInterval,
} from './plans';

// Phase 18 §2.7 / 21.5 — what scripts/billing/seed-stripe-test.ts and portal-config.ts create in
// Stripe, as pure data (unit tested). Docs read 2026-09-29 and re-read 2026-10-04:
//   Products create (custom id, metadata, tax_code)  https://docs.stripe.com/api/products/create
//   Prices create (lookup_key, transfer_lookup_key,
//     tax_behavior, recurring.interval day|week|month|year)
//                                                    https://docs.stripe.com/api/prices/create
//   Product tax codes: SaaS business use txcd_10103001 https://docs.stripe.com/tax/tax-codes
//   Customer Portal configuration                     https://docs.stripe.com/api/customer_portal/configurations/create
//
// 26.1 catalogue: one product per plan (studio_plan_starter / _growth / _pro, metadata
// studio_tier=STANDARD, studio_plan=<plan>) with three recurring GBP prices each (lookup keys
// studio_<plan>_<weekly|monthly|yearly>; subscription quantity 1): Starter £9.50 / £29 / £290,
// Growth £22.50 / £69 / £690, Pro £48.50 / £149 / £1,490; and one product + one-time price per HD
// video pack (studio_pack_hd5 £17, studio_pack_hd15 £45). All tax-exclusive. The 21.5 channel
// product (studio_channel) is left alone: archive its prices once migrate-to-tiers.ts has run.

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
  interval: PlanInterval | null;
}

/** One product per plan and one product per HD video pack. */
export function catalogueProducts(): ProductSpec[] {
  const plans = PLAN_IDS.map((plan): ProductSpec => ({
    id: planProductId(plan),
    name: `PostMind Studio ${PLAN_NAMES[plan]}`,
    metadata: { studio_tier: PLAN_TIER, studio_catalogue: 'plan', studio_plan: plan },
  }));
  const packs = TOP_UP_PACKS.map((pack) => ({
    id: pack.lookupKey,
    name: `PostMind Studio video pack: ${pack.quantity} HD videos`,
    metadata: {
      studio_catalogue: 'video_pack',
      studio_pack_videos: String(pack.quantity),
      studio_pack_valid_months: String(pack.validMonths),
    },
  }));
  return [...plans, ...packs];
}

/** The 9 recurring plan prices (3 plans × 3 intervals) and the 2 one-time pack prices. */
export function cataloguePrices(): PriceSpec[] {
  const recurring = PLAN_IDS.flatMap((plan) =>
    PLAN_INTERVALS.map((interval) => ({
      productId: planProductId(plan),
      lookupKey: planLookupKey(plan, interval),
      unitAmountPence: requiredAmount(planLookupKey(plan, interval)),
      interval,
    })),
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
  if (amount === undefined) throw new RangeError(`No reference amount for ${lookupKey}`);
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
    ...(spec.interval && { recurring: { interval: spec.interval, usage_type: 'licensed' } }),
    metadata: { studio_lookup_key: spec.lookupKey },
  };
}

/** Does an existing Stripe price already match the spec (so the seed leaves it alone)? */
export function priceMatches(
  existing: {
    unitAmountPence: number | null;
    currency: string;
    interval: PlanInterval | null;
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
 * 21.5 portal: payment methods, invoices, billing details and tax ids ONLY. Plan changes,
 * interval switches and cancelling happen on Studio's "Your plan" page (one set of rules, shown
 * before anything is charged), so the portal's subscription update and cancel are off.
 */
export function portalConfigurationParams(input: {
  appUrl: string;
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
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false },
    },
  };
}
