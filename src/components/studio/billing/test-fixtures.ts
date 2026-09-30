import { REFERENCE_PRICES_PENCE } from '@/lib/studio/billing/catalogue';
import type { PriceState } from '@/lib/studio/billing/gateway';
import { buildPricingView } from '@/lib/studio/billing/pricing';
import type { BillingResponse, PricingView } from './types';

// Test fixtures for the billing screens: Stripe prices as prices.list returns them (the §P.2
// reference amounts), turned into the PricingView the API serves by the real buildPricingView.

export const NOW = new Date('2026-09-29T12:00:00.000Z');

export function stripePrices(overrides: Record<string, number> = {}): PriceState[] {
  return Object.entries({ ...REFERENCE_PRICES_PENCE, ...overrides }).map(([lookupKey, amount]) => ({
    id: `price_${lookupKey}`,
    lookupKey,
    unitAmountPence: amount,
    currency: 'gbp',
    interval: lookupKey.includes('topup') ? null : lookupKey.endsWith('yearly') ? 'year' : 'month',
    active: true,
    productName: lookupKey,
    productTier: null,
    taxBehavior: 'exclusive',
  }));
}

export function pricingView(prices: PriceState[] | null = stripePrices()): PricingView {
  return buildPricingView(prices, NOW, { STUDIO_TRIAL_DAYS: '14' });
}

type Billing = BillingResponse['billing'];

export function billing(patch: Partial<Billing> = {}): Billing {
  return {
    catalogueVersion: '2026-09-30',
    entitlements: {
      tier: 'STANDARD',
      access: 'full',
      source: 'stripe',
      graceUntil: null,
      limits: { seats: 5, businesses: 3, storageGb: 100 },
      custom: null,
      trial: null,
      subscriptionStatus: 'active',
    },
    subscription: {
      status: 'active',
      lookupKey: 'studio_standard_monthly',
      interval: 'month',
      currentPeriodEnd: '2026-10-29T12:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
    },
    hasBillingAccount: true,
    trialEligible: false,
    credits: { short: 7, long: 0 },
    usage: {
      seats: { used: 2, limit: 5 },
      businesses: { used: 1, limit: 3 },
      storage: { usedBytes: String(12 * 1024 ** 3), limitGb: 100, percent: 12 },
      cost: { month: '2026-09', spentPence: 4_500, capPence: 7_300, headroomPence: 0 },
    },
    canManage: true,
    checkoutEnabled: true,
    ...patch,
  };
}
