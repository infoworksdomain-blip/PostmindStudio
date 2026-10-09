import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { allLookupKeys } from './catalogue';
import { STRIPE_MAX_LOOKUP_KEYS, listPricesByLookupKeys, lookupKeyBatches } from './stripe-lookup';

describe('Stripe lookup-key batching (prices.list takes at most 10 lookup_keys)', () => {
  it('splits keys into batches of at most 10, without duplicates, in order', () => {
    const keys = Array.from({ length: 23 }, (_, i) => `k${i}`);
    const batches = lookupKeyBatches([...keys, 'k0']);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(batches.flat()).toEqual(keys);
    expect(lookupKeyBatches([])).toEqual([]);
  });

  it('26.1: the catalogue (9 plan prices + 2 packs) takes two requests', () => {
    expect(allLookupKeys()).toHaveLength(11);
    expect(allLookupKeys().length).toBeGreaterThan(STRIPE_MAX_LOOKUP_KEYS);
    const batches = lookupKeyBatches(allLookupKeys());
    expect(batches.map((b) => b.length)).toEqual([10, 1]);
    expect(batches.flat()).toEqual(allLookupKeys());
  });

  it('lists every batch and combines the prices, passing params and request options through', async () => {
    const list = vi.fn(async (params: Stripe.PriceListParams) => ({
      data: (params.lookup_keys ?? []).map((key) => ({ id: `price_${key}`, lookup_key: key })),
    }));
    const prices = { list } as unknown as Pick<Stripe.PriceResource, 'list'>;
    const keys = [...allLookupKeys(), ...Array.from({ length: 12 }, (_, i) => `extra_${i}`)];
    const result = await listPricesByLookupKeys(
      prices,
      keys,
      { active: true, expand: ['data.product'] },
      { timeout: 4_000, maxNetworkRetries: 0 },
    );
    expect(result.map((p) => p.lookup_key)).toEqual(keys);
    for (const [params, options] of list.mock.calls as unknown as [
      Stripe.PriceListParams,
      Stripe.RequestOptions,
    ][]) {
      expect(params.lookup_keys!.length).toBeLessThanOrEqual(STRIPE_MAX_LOOKUP_KEYS);
      expect(params).toMatchObject({ active: true, expand: ['data.product'], limit: 100 });
      expect(options).toEqual({ timeout: 4_000, maxNetworkRetries: 0 });
    }
    expect(list).toHaveBeenCalledTimes(Math.ceil(keys.length / STRIPE_MAX_LOOKUP_KEYS));
  });
});
