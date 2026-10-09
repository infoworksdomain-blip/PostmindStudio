import { planForLookupKey, REFERENCE_PRICES_PENCE } from '@/lib/studio/billing/catalogue';
import type { PriceState } from '@/lib/studio/billing/gateway';
import { buildPricingView } from '@/lib/studio/billing/pricing';
import type { BillingResponse, PricingView } from './types';

// Test fixtures for the billing screens: Stripe prices as prices.list returns them (the 26.1 plan
// reference amounts and the HD packs), turned into the PricingView the API serves by the real
// buildPricingView.

export const NOW = new Date('2026-09-29T12:00:00.000Z');

export function stripePrices(overrides: Record<string, number> = {}): PriceState[] {
  return Object.entries({ ...REFERENCE_PRICES_PENCE, ...overrides }).map(([lookupKey, amount]) => ({
    id: `price_${lookupKey}`,
    lookupKey,
    unitAmountPence: amount,
    currency: 'gbp',
    interval: planForLookupKey(lookupKey)?.interval ?? null,
    active: true,
    productName: lookupKey,
    productTier: null,
    taxBehavior: 'exclusive',
  }));
}

export function pricingView(prices: PriceState[] | null = stripePrices()): PricingView {
  return buildPricingView(prices, NOW, { STUDIO_TRIAL_DAYS: '7' });
}

type Billing = BillingResponse['billing'];

/** An owner's organisation on Growth, monthly. */
export function billing(patch: Partial<Billing> = {}): Billing {
  return {
    catalogueVersion: '2026-10-09',
    entitlements: {
      tier: 'STANDARD',
      access: 'full',
      source: 'stripe',
      graceUntil: null,
      limits: { seats: 3, businesses: 1, storageGb: 100 },
      custom: null,
      trial: null,
      subscriptionStatus: 'active',
    },
    subscription: {
      status: 'active',
      lookupKey: 'studio_growth_monthly',
      interval: 'month',
      quantity: 1,
      currentPeriodEnd: '2026-10-29T12:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
    },
    plan: {
      id: 'growth',
      interval: 'month',
      source: 'stripe',
      legacy: false,
      pricePerPeriodPence: 6_900,
      currency: 'gbp',
      pending: null,
      paymentPending: false,
    },
    hasBillingAccount: true,
    trialEligible: false,
    credits: { short: 7, long: 0 },
    usage: {
      seats: { used: 2, limit: 3 },
      businesses: { used: 1, limit: 1 },
      storage: { usedBytes: String(12 * 1024 ** 3), limitGb: 100, percent: 12 },
    },
    canManage: true,
    checkoutEnabled: true,
    ...patch,
  };
}

/** No plan yet (no subscription). */
export function noPlan(patch: Partial<Billing> = {}): Billing {
  return billing({
    entitlements: {
      ...billing().entitlements,
      access: 'none',
      source: 'none',
      subscriptionStatus: null,
    },
    subscription: null,
    plan: null,
    hasBillingAccount: false,
    trialEligible: true,
    credits: { short: 0, long: 0 },
    ...patch,
  });
}

/** GET /usage for a plan (Growth: 20 videos this month). */
export function usage(used = 5, limit = 20, period: 'week' | 'month' = 'month') {
  return {
    usage: {
      organisationId: 'org-1',
      planTier: 'STANDARD' as const,
      mode: 'enforce' as const,
      month: '2026-09',
      period,
      studioPlan: true,
      periodStart: '2026-09-01T00:00:00.000Z',
      resetsAt: '2026-10-01T00:00:00.000Z',
      thresholds: [80, 100],
      status: 'ok' as const,
      videos: {
        short: { used, limit, percent: Math.round((used / limit) * 100), maxDurationSec: 30 },
        long: { used: 0, limit: 0, percent: 0, maxDurationSec: 0 },
      },
      platforms: { rule: 'all', description: 'All platforms' },
      scans: { businessesScanned: 1, limit: 3 },
    },
  };
}
