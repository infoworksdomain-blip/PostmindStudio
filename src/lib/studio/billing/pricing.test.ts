import { describe, expect, it, vi } from 'vitest';
import type { PriceState, StripeGateway } from './gateway';
import { buildPricingView, createPricingSource, PRICING_CACHE_TTL_MS } from './pricing';
import { allLookupKeys, REFERENCE_PRICES_PENCE } from './catalogue';

const now = new Date('2026-09-29T00:00:00Z');

function prices(overrides: Record<string, Partial<PriceState>> = {}): PriceState[] {
  return Object.entries(REFERENCE_PRICES_PENCE).map(([lookupKey, amount]) => ({
    id: `price_${lookupKey}`,
    lookupKey,
    unitAmountPence: amount,
    currency: 'gbp',
    interval: lookupKey.endsWith('_yearly')
      ? 'year'
      : lookupKey.endsWith('_monthly')
        ? 'month'
        : null,
    active: true,
    productName: null,
    productTier: null,
    taxBehavior: 'exclusive',
    ...overrides[lookupKey],
  }));
}

describe('buildPricingView (amounts from Stripe prices.list by lookup key)', () => {
  it('shows the Stripe amounts, the annual saving, the trial and the top-ups', () => {
    const view = buildPricingView(prices(), now, {});
    expect(view.available).toBe(true);
    const standard = view.plans.find((p) => p.tier === 'STANDARD');
    expect(standard?.prices.month).toEqual({
      lookupKey: 'studio_standard_monthly',
      unitAmountPence: 9_900,
    });
    expect(standard?.prices.year?.unitAmountPence).toBe(99_000);
    expect(standard?.annualSavingPence).toBe(9_900 * 12 - 99_000);
    expect(standard?.trialDays).toBe(14);
    expect(view.plans.find((p) => p.tier === 'BASIC')?.trialDays).toBe(0);
    const enterprise = view.plans.find((p) => p.tier === 'ENTERPRISE');
    expect(enterprise?.selfServe).toBe(false);
    expect(enterprise?.prices).toEqual({});
    expect(view.topUps.map((t) => t.unitAmountPence)).toEqual([1_500, 2_500, 3_500, 2_900, 5_500]);
    expect(view.trial).toEqual({ tier: 'STANDARD', days: 14, shortVideos: 5, longVideos: 1 });
  });

  it('a price changed in Stripe shows its new amount with no code change', () => {
    const view = buildPricingView(
      prices({ studio_plus_monthly: { unitAmountPence: 79_900 } }),
      now,
      {},
    );
    expect(view.plans.find((p) => p.tier === 'PLUS')?.prices.month?.unitAmountPence).toBe(79_900);
  });

  it('never shows a non-GBP, inactive or missing price', () => {
    const view = buildPricingView(
      prices({
        studio_basic_monthly: { currency: 'usd' },
        studio_basic_yearly: { active: false },
      }).filter((p) => p.lookupKey !== 'studio_topup_long2_plus'),
      now,
      {},
    );
    const basic = view.plans.find((p) => p.tier === 'BASIC');
    expect(basic?.prices.month?.unitAmountPence).toBeNull();
    expect(basic?.prices.year?.unitAmountPence).toBeNull();
    expect(basic?.annualSavingPence).toBeNull();
    expect(
      view.topUps.find((t) => t.lookupKey === 'studio_topup_long2_plus')?.unitAmountPence,
    ).toBeNull();
  });

  it('Stripe unavailable → available=false and no amounts', () => {
    const view = buildPricingView(null, now, { STUDIO_TRIAL_DAYS: '0' });
    expect(view.available).toBe(false);
    expect(
      view.plans.every((p) => Object.values(p.prices).every((v) => v?.unitAmountPence === null)),
    ).toBe(true);
    expect(view.trial.days).toBe(0);
  });
});

describe('createPricingSource (10-minute cache)', () => {
  function gateway(impl: StripeGateway['listPrices']): StripeGateway {
    return { listPrices: vi.fn(impl) } as unknown as StripeGateway;
  }

  it('asks Stripe for every lookup key once per 10 minutes', async () => {
    let t = now.getTime();
    const gw = gateway(async () => prices());
    const source = createPricingSource({
      gateway: gw,
      logger: { warn: vi.fn() },
      now: () => t,
      env: {},
    });
    await source.get();
    await source.get();
    expect(gw.listPrices).toHaveBeenCalledTimes(1);
    expect(gw.listPrices).toHaveBeenCalledWith(allLookupKeys());
    t += PRICING_CACHE_TTL_MS + 1;
    await source.get();
    expect(gw.listPrices).toHaveBeenCalledTimes(2);
    source.clear();
    await source.get();
    expect(gw.listPrices).toHaveBeenCalledTimes(3);
  });

  it('a failed read is logged, shown as unavailable and retried after a minute', async () => {
    let t = now.getTime();
    const warn = vi.fn();
    const gw = gateway(async () => {
      throw new Error('stripe down');
    });
    const source = createPricingSource({ gateway: gw, logger: { warn }, now: () => t, env: {} });
    expect((await source.get()).available).toBe(false);
    expect(warn).toHaveBeenCalled();
    await source.get();
    expect(gw.listPrices).toHaveBeenCalledTimes(1);
    t += 61_000;
    await source.get();
    expect(gw.listPrices).toHaveBeenCalledTimes(2);
  });

  it('without Stripe configured the page still renders the catalogue', async () => {
    const source = createPricingSource({ gateway: undefined, logger: { warn: vi.fn() }, env: {} });
    const view = await source.get();
    expect(view.available).toBe(false);
    expect(view.plans).toHaveLength(4);
  });
});
