import { describe, expect, it, vi } from 'vitest';
import type { PriceState, StripeGateway } from './gateway';
import { buildPricingView, createPricingSource, PRICING_CACHE_TTL_MS } from './pricing';
import { allLookupKeys, planForLookupKey, REFERENCE_PRICES_PENCE } from './catalogue';

const now = new Date('2026-09-29T00:00:00Z');

function prices(overrides: Record<string, Partial<PriceState>> = {}): PriceState[] {
  return Object.entries(REFERENCE_PRICES_PENCE).map(([lookupKey, amount]) => ({
    id: `price_${lookupKey}`,
    lookupKey,
    unitAmountPence: amount,
    currency: 'gbp',
    interval: planForLookupKey(lookupKey)?.interval ?? null,
    active: true,
    productName: null,
    productTier: null,
    taxBehavior: 'exclusive',
    ...overrides[lookupKey],
  }));
}

describe('buildPricingView (26.1: three plans, prices from Stripe by lookup key)', () => {
  it('shows each plan: prices per interval, videos, businesses, seats, saving; the trial and the packs', () => {
    const view = buildPricingView(prices(), now, {});
    expect(view.available).toBe(true);
    expect(view.plans.map((p) => p.plan)).toEqual(['starter', 'growth', 'pro']);
    expect(view.plans.map((p) => p.mostPopular)).toEqual([false, true, false]);
    expect(
      view.plans.map((p) => [
        p.plan,
        p.prices.week.unitAmountPence,
        p.prices.month.unitAmountPence,
        p.prices.year.unitAmountPence,
        p.videosPerMonth,
        p.videosPerWeek,
        p.businesses,
        p.seats,
        p.yearlySavingPence,
      ]),
    ).toEqual([
      ['starter', 950, 2_900, 29_000, 8, 2, 1, 1, 5_800],
      ['growth', 2_250, 6_900, 69_000, 20, 5, 1, 3, 13_800],
      ['pro', 4_850, 14_900, 149_000, 45, 11, 3, 10, 29_800],
    ]);
    expect(view.plans[1]?.prices.week.lookupKey).toBe('studio_growth_weekly');
    expect(view.topUps.map((t) => [t.lookupKey, t.quantity, t.unitAmountPence])).toEqual([
      ['studio_pack_hd5', 5, 1_700],
      ['studio_pack_hd15', 15, 4_500],
    ]);
    expect(view.trial).toEqual({ days: 7, videos: 2 });
  });

  it('never carries a cost, budget or per-video figure', () => {
    const json = JSON.stringify(buildPricingView(prices(), now, {}));
    expect(json).not.toMatch(/cost|budget|cap|perVideo/i);
  });

  it('a price changed in Stripe shows its new amount with no code change', () => {
    const view = buildPricingView(
      prices({ studio_growth_monthly: { unitAmountPence: 7_100 } }),
      now,
      {},
    );
    const growth = view.plans.find((p) => p.plan === 'growth');
    expect(growth?.prices.month.unitAmountPence).toBe(7_100);
    expect(growth?.yearlySavingPence).toBe(7_100 * 12 - 69_000);
  });

  it('never shows a non-GBP, inactive or missing price', () => {
    const view = buildPricingView(
      prices({
        studio_pro_weekly: { currency: 'usd' },
        studio_pro_yearly: { active: false },
      }).filter((p) => p.lookupKey !== 'studio_pack_hd15'),
      now,
      {},
    );
    const pro = view.plans.find((p) => p.plan === 'pro');
    expect(pro?.prices.week.unitAmountPence).toBeNull();
    expect(pro?.prices.year.unitAmountPence).toBeNull();
    expect(pro?.yearlySavingPence).toBeNull();
    expect(view.topUps.find((t) => t.lookupKey === 'studio_pack_hd15')?.unitAmountPence).toBeNull();
  });

  it('Stripe unavailable → available=false and no amounts', () => {
    const view = buildPricingView(null, now, { STUDIO_TRIAL_DAYS: '0' });
    expect(view.available).toBe(false);
    expect(
      view.plans.every((p) => Object.values(p.prices).every((i) => i.unitAmountPence === null)),
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
    expect(view.plans).toHaveLength(3);
  });
});
