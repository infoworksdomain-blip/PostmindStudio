import { describe, expect, it } from 'vitest';
import {
  catalogueProducts,
  cataloguePrices,
  portalConfigurationParams,
  priceCreateParams,
  priceMatches,
} from './stripe-setup';
import { isTestModeKey, STRIPE_API_VERSION } from './stripe-client';

describe('seed catalogue (scripts/billing/seed-stripe-test.ts, 26.1)', () => {
  it('creates one product per plan (STANDARD) and one product per HD video pack', () => {
    const products = catalogueProducts();
    expect(products.map((p) => [p.id, p.name])).toEqual([
      ['studio_plan_starter', 'PostMind Studio Starter'],
      ['studio_plan_growth', 'PostMind Studio Growth'],
      ['studio_plan_pro', 'PostMind Studio Pro'],
      ['studio_pack_hd5', 'PostMind Studio video pack: 5 HD videos'],
      ['studio_pack_hd15', 'PostMind Studio video pack: 15 HD videos'],
    ]);
    expect(products[1]?.metadata).toEqual({
      studio_tier: 'STANDARD',
      studio_catalogue: 'plan',
      studio_plan: 'growth',
    });
    expect(products[4]?.metadata).toMatchObject({
      studio_catalogue: 'video_pack',
      studio_pack_videos: '15',
      studio_pack_valid_months: '3',
    });
  });

  it('creates 9 recurring plan prices (quantity 1) and 2 one-time packs, GBP, tax exclusive', () => {
    const specs = cataloguePrices();
    expect(specs.map((s) => [s.productId, s.lookupKey, s.unitAmountPence, s.interval])).toEqual([
      ['studio_plan_starter', 'studio_starter_weekly', 950, 'week'],
      ['studio_plan_starter', 'studio_starter_monthly', 2_900, 'month'],
      ['studio_plan_starter', 'studio_starter_yearly', 29_000, 'year'],
      ['studio_plan_growth', 'studio_growth_weekly', 2_250, 'week'],
      ['studio_plan_growth', 'studio_growth_monthly', 6_900, 'month'],
      ['studio_plan_growth', 'studio_growth_yearly', 69_000, 'year'],
      ['studio_plan_pro', 'studio_pro_weekly', 4_850, 'week'],
      ['studio_plan_pro', 'studio_pro_monthly', 14_900, 'month'],
      ['studio_plan_pro', 'studio_pro_yearly', 149_000, 'year'],
      ['studio_pack_hd5', 'studio_pack_hd5', 1_700, null],
      ['studio_pack_hd15', 'studio_pack_hd15', 4_500, null],
    ]);
    const weekly = priceCreateParams(specs[3]!);
    expect(weekly).toEqual({
      product: 'studio_plan_growth',
      currency: 'gbp',
      unit_amount: 2_250,
      lookup_key: 'studio_growth_weekly',
      transfer_lookup_key: true,
      tax_behavior: 'exclusive',
      recurring: { interval: 'week', usage_type: 'licensed' },
      metadata: { studio_lookup_key: 'studio_growth_weekly' },
    });
    const pack = priceCreateParams(specs.find((s) => s.lookupKey === 'studio_pack_hd15')!);
    expect(pack.recurring).toBeUndefined();
    expect(pack).toMatchObject({ product: 'studio_pack_hd15', unit_amount: 4_500 });
  });

  it('leaves a matching price alone and replaces a changed one', () => {
    const spec = cataloguePrices()[1]!;
    const same = {
      unitAmountPence: 2_900,
      currency: 'gbp',
      interval: 'month' as const,
      active: true,
    };
    expect(priceMatches(same, spec)).toBe(true);
    expect(priceMatches({ ...same, unitAmountPence: 6_900 }, spec)).toBe(false);
    expect(priceMatches({ ...same, interval: 'year' }, spec)).toBe(false);
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

describe('portal configuration (scripts/billing/portal-config.ts, 21.5)', () => {
  it('payment methods, invoices, billing details and tax ids only; plan changes stay in Studio', () => {
    const params = portalConfigurationParams({ appUrl: 'https://studio.example.com' });
    expect(params.default_return_url).toBe('https://studio.example.com/settings/billing');
    expect(params.business_profile?.terms_of_service_url).toBe(
      'https://studio.example.com/legal/terms',
    );
    expect(params.features.invoice_history?.enabled).toBe(true);
    expect(params.features.payment_method_update?.enabled).toBe(true);
    expect(params.features.customer_update?.allowed_updates).toContain('tax_id');
    expect(params.features.subscription_cancel).toEqual({ enabled: false });
    expect(params.features.subscription_update).toEqual({ enabled: false });
  });
});
