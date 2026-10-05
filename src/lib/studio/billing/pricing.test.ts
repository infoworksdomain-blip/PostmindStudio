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

describe('buildPricingView (21.5: per-channel prices from Stripe by lookup key)', () => {
  it('shows the per-channel price of each interval, the videos, the saving, the trial and the packs', () => {
    const view = buildPricingView(prices(), now, {});
    expect(view.available).toBe(true);
    expect(view.channels).toEqual({ min: 1, max: 6 });
    expect(view.intervals).toEqual([
      {
        interval: 'week',
        lookupKey: 'studio_channel_weekly',
        unitAmountPence: 950,
        videosPerChannel: 2,
      },
      {
        interval: 'month',
        lookupKey: 'studio_channel_monthly',
        unitAmountPence: 2_900,
        videosPerChannel: 8,
      },
      {
        interval: 'year',
        lookupKey: 'studio_channel_yearly',
        unitAmountPence: 29_000,
        videosPerChannel: 96,
      },
    ]);
    expect(view.yearlySavingPerChannelPence).toBe(2_900 * 12 - 29_000);
    expect(view.topUps.map((t) => [t.lookupKey, t.quantity, t.unitAmountPence])).toEqual([
      ['studio_pack_hd5', 5, 1_500],
      ['studio_pack_hd15', 15, 3_900],
    ]);
    expect(view.trial).toEqual({ days: 14, videos: 5 });
  });

  it('never carries a cost or budget figure', () => {
    const json = JSON.stringify(buildPricingView(prices(), now, {}));
    expect(json).not.toMatch(/cost|budget|cap/i);
  });

  it('a price changed in Stripe shows its new amount with no code change', () => {
    const view = buildPricingView(
      prices({ studio_channel_monthly: { unitAmountPence: 3_100 } }),
      now,
      {},
    );
    expect(view.intervals.find((i) => i.interval === 'month')?.unitAmountPence).toBe(3_100);
    expect(view.yearlySavingPerChannelPence).toBe(3_100 * 12 - 29_000);
  });

  it('never shows a non-GBP, inactive or missing price', () => {
    const view = buildPricingView(
      prices({
        studio_channel_weekly: { currency: 'usd' },
        studio_channel_yearly: { active: false },
      }).filter((p) => p.lookupKey !== 'studio_pack_hd15'),
      now,
      {},
    );
    expect(view.intervals.find((i) => i.interval === 'week')?.unitAmountPence).toBeNull();
    expect(view.intervals.find((i) => i.interval === 'year')?.unitAmountPence).toBeNull();
    expect(view.yearlySavingPerChannelPence).toBeNull();
    expect(view.topUps.find((t) => t.lookupKey === 'studio_pack_hd15')?.unitAmountPence).toBeNull();
  });

  it('Stripe unavailable → available=false and no amounts', () => {
    const view = buildPricingView(null, now, { STUDIO_TRIAL_DAYS: '0' });
    expect(view.available).toBe(false);
    expect(view.intervals.every((i) => i.unitAmountPence === null)).toBe(true);
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
    expect(view.intervals).toHaveLength(3);
  });
});
