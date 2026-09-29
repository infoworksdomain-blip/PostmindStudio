import { describe, expect, it } from 'vitest';
import {
  catalogueProducts,
  cataloguePrices,
  portalConfigurationParams,
  priceCreateParams,
  priceMatches,
  productIdForTier,
} from './stripe-setup';
import { isTestModeKey, STRIPE_API_VERSION } from './stripe-client';

describe('seed catalogue (scripts/billing/seed-stripe-test.ts)', () => {
  it('creates 4 plan products and 5 top-up products with studio_tier metadata', () => {
    const products = catalogueProducts();
    expect(products.map((p) => p.id)).toEqual([
      'studio_basic',
      'studio_standard',
      'studio_plus',
      'studio_enterprise',
      'studio_topup_short10_basic',
      'studio_topup_short10_standard',
      'studio_topup_short10_plus',
      'studio_topup_long2_standard',
      'studio_topup_long2_plus',
    ]);
    expect(products.find((p) => p.id === 'studio_enterprise')?.metadata.studio_tier).toBe(
      'ENTERPRISE',
    );
  });

  it('creates exactly the §P.2 prices: 6 recurring + 5 one-time, GBP, tax exclusive', () => {
    const specs = cataloguePrices();
    expect(specs.filter((s) => s.interval).map((s) => [s.lookupKey, s.unitAmountPence])).toEqual([
      ['studio_basic_monthly', 5_900],
      ['studio_basic_yearly', 59_000],
      ['studio_standard_monthly', 20_900],
      ['studio_standard_yearly', 209_000],
      ['studio_plus_monthly', 74_900],
      ['studio_plus_yearly', 823_900],
    ]);
    expect(specs.filter((s) => !s.interval)).toHaveLength(5);
    const monthly = priceCreateParams(specs[0]!);
    expect(monthly).toMatchObject({
      product: 'studio_basic',
      currency: 'gbp',
      unit_amount: 5_900,
      lookup_key: 'studio_basic_monthly',
      transfer_lookup_key: true,
      tax_behavior: 'exclusive',
      recurring: { interval: 'month' },
    });
    const topup = priceCreateParams(specs.find((s) => s.lookupKey === 'studio_topup_long2_plus')!);
    expect(topup.recurring).toBeUndefined();
    expect(topup.unit_amount).toBe(8_900);
  });

  it('leaves a matching price alone and replaces a changed one', () => {
    const spec = cataloguePrices()[0]!;
    const same = {
      unitAmountPence: 5_900,
      currency: 'gbp',
      interval: 'month' as const,
      active: true,
    };
    expect(priceMatches(same, spec)).toBe(true);
    expect(priceMatches({ ...same, unitAmountPence: 6_900 }, spec)).toBe(false);
    expect(priceMatches({ ...same, active: false }, spec)).toBe(false);
    expect(priceMatches({ ...same, currency: 'usd' }, spec)).toBe(false);
  });

  it('only seeds test-mode accounts; pins the API version', () => {
    expect(isTestModeKey('sk_test_abc')).toBe(true);
    expect(isTestModeKey('rk_test_abc')).toBe(true);
    expect(isTestModeKey('sk_live_abc')).toBe(false);
    expect(STRIPE_API_VERSION).toBe('2026-08-26.dahlia');
  });
});

describe('portal configuration (scripts/billing/portal-config.ts)', () => {
  it('matches §2.7: invoices, payment methods, tax ids, plan switching, cancel at period end', () => {
    const params = portalConfigurationParams({
      appUrl: 'https://studio.example.com',
      products: [{ productId: productIdForTier('PLUS'), priceIds: ['price_a', 'price_b'] }],
    });
    expect(params.default_return_url).toBe('https://studio.example.com/settings/billing');
    expect(params.business_profile?.terms_of_service_url).toBe(
      'https://studio.example.com/legal/terms',
    );
    expect(params.features.invoice_history.enabled).toBe(true);
    expect(params.features.payment_method_update?.enabled).toBe(true);
    expect(params.features.customer_update?.allowed_updates).toContain('tax_id');
    expect(params.features.subscription_cancel).toMatchObject({
      enabled: true,
      mode: 'at_period_end',
      cancellation_reason: { enabled: true },
    });
    expect(params.features.subscription_update).toMatchObject({
      enabled: true,
      proration_behavior: 'always_invoice',
      schedule_at_period_end: {
        conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }],
      },
      products: [{ product: 'studio_plus', prices: ['price_a', 'price_b'] }],
    });
  });
});
