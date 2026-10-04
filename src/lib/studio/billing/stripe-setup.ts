import type Stripe from 'stripe';
import { REFERENCE_PRICES_PENCE, TOP_UP_PACKS } from './catalogue';
import {
  CHANNEL_INTERVALS,
  CHANNEL_LOOKUP_KEYS,
  CHANNEL_PLAN_TIER,
  CHANNEL_PRODUCT_ID,
  type ChannelInterval,
} from './channel-plan';

// Phase 18 §2.7 / 21.5 — what scripts/billing/seed-stripe-test.ts and portal-config.ts create in
// Stripe, as pure data (unit tested). Docs read 2026-09-29 and re-read 2026-10-04:
//   Products create (custom id, metadata, tax_code)  https://docs.stripe.com/api/products/create
//   Prices create (lookup_key, transfer_lookup_key,
//     tax_behavior, recurring.interval day|week|month|year)
//                                                    https://docs.stripe.com/api/prices/create
//   Per-seat (per-unit) pricing: one price, the subscription item's quantity multiplies it
//                                                    https://docs.stripe.com/subscriptions/pricing-models/per-seat-pricing
//   Product tax codes: SaaS business use txcd_10103001 https://docs.stripe.com/tax/tax-codes
//   Customer Portal configuration                     https://docs.stripe.com/api/customer_portal/configurations/create
//
// 21.5 catalogue: ONE product (studio_channel, metadata studio_tier=STANDARD) with three
// recurring GBP prices, per unit (quantity = channels): studio_channel_weekly £9.50/week,
// studio_channel_monthly £29/month, studio_channel_yearly £290/year; and one product + one-time
// price per HD video pack (studio_pack_hd5 £15, studio_pack_hd15 £39). All tax-exclusive.

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
  interval: ChannelInterval | null;
}

/** The channel product and one product per HD video pack. */
export function catalogueProducts(): ProductSpec[] {
  const channel: ProductSpec = {
    id: CHANNEL_PRODUCT_ID,
    name: 'PostMind Studio channel',
    metadata: { studio_tier: CHANNEL_PLAN_TIER, studio_catalogue: 'channel_plan' },
  };
  const packs = TOP_UP_PACKS.map((pack) => ({
    id: pack.lookupKey,
    name: `PostMind Studio video pack: ${pack.quantity} HD videos`,
    metadata: {
      studio_catalogue: 'video_pack',
      studio_pack_videos: String(pack.quantity),
      studio_pack_valid_months: String(pack.validMonths),
    },
  }));
  return [channel, ...packs];
}

/** The 3 recurring per-channel prices and the 2 one-time pack prices. */
export function cataloguePrices(): PriceSpec[] {
  const recurring = CHANNEL_INTERVALS.map((interval) => ({
    productId: CHANNEL_PRODUCT_ID,
    lookupKey: CHANNEL_LOOKUP_KEYS[interval],
    unitAmountPence: requiredAmount(CHANNEL_LOOKUP_KEYS[interval]),
    interval,
  }));
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
    // Per unit (the default billing_scheme): the subscription item quantity = channels.
    ...(spec.interval && { recurring: { interval: spec.interval, usage_type: 'licensed' } }),
    metadata: { studio_lookup_key: spec.lookupKey },
  };
}

/** Does an existing Stripe price already match the spec (so the seed leaves it alone)? */
export function priceMatches(
  existing: {
    unitAmountPence: number | null;
    currency: string;
    interval: ChannelInterval | null;
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
