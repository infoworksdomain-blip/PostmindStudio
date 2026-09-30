import type Stripe from 'stripe';

// Stripe's prices.list accepts at most 10 lookup_keys per request ("Array lookup_keys exceeded
// maximum 10 allowed elements", seen against the API on 2026-09-30; the list-prices reference
// documents lookup_keys as "up to 10"): https://docs.stripe.com/api/prices/list (read 2026-09-30).
// The catalogue has more prices than that (6 recurring + 5 top-ups), so every lookup goes through
// here in batches.

export const STRIPE_MAX_LOOKUP_KEYS = 10;

/** Split lookup keys into Stripe-sized batches, dropping duplicates and keeping order. */
export function lookupKeyBatches(keys: readonly string[]): string[][] {
  const unique = [...new Set(keys)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += STRIPE_MAX_LOOKUP_KEYS)
    batches.push(unique.slice(i, i + STRIPE_MAX_LOOKUP_KEYS));
  return batches;
}

type PriceListParams = Omit<Stripe.PriceListParams, 'lookup_keys'>;

/** prices.list for any number of lookup keys: one request per batch of 10, results combined. */
export async function listPricesByLookupKeys(
  prices: Pick<Stripe.PriceResource, 'list'>,
  keys: readonly string[],
  params: PriceListParams = {},
  options?: Stripe.RequestOptions,
): Promise<Stripe.Price[]> {
  const pages = await Promise.all(
    lookupKeyBatches(keys).map((batch) =>
      prices.list({ ...params, lookup_keys: batch, limit: params.limit ?? 100 }, options),
    ),
  );
  return pages.flatMap((page) => page.data);
}
