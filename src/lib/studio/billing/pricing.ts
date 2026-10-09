import type { Logger } from 'pino';
import { allLookupKeys, CATALOGUE_VERSION, TOP_UP_PACKS, TRIAL, type TopUpPack } from './catalogue';
import {
  MOST_POPULAR_PLAN,
  PLAN_IDS,
  PLAN_INTERVALS,
  planLookupKey,
  STUDIO_PLANS,
  type PlanId,
  type PlanInterval,
} from './plans';
import { trialDays } from './entitlements';
import type { PriceState, StripeGateway } from './gateway';

// Phase 18 §2.7 / 26.1 — what /pricing, the landing page, the upgrade dialog and "Your plan" show:
// the three plans (Starter / Growth / Pro) with the price of each interval (weekly, monthly,
// yearly), the HD videos, businesses and seats each includes, and the HD video packs. Amounts come from Stripe by lookup key (prices.list lookup_keys + expand
// data.product), cached for 10 minutes, so the operator changes a price in Stripe (new Price +
// transfer_lookup_key) with no deploy. A missing or non-GBP price shows as "unavailable" rather
// than a made-up number. Never any generation cost (21.5: costs are internal).

export const PRICING_CACHE_TTL_MS = 10 * 60_000;
export const PRICING_CURRENCY = 'gbp';

export interface PriceView {
  lookupKey: string;
  /** null = no active GBP price with this lookup key in Stripe. */
  unitAmountPence: number | null;
}

/** One plan as customers see it (every plan posts to every platform). */
export interface PlanPricingView {
  plan: PlanId;
  mostPopular: boolean;
  /** HD videos a month (monthly; yearly gets the same each calendar month). */
  videosPerMonth: number;
  /** HD videos a week on the weekly interval. */
  videosPerWeek: number;
  businesses: number;
  seats: number;
  /** The price of each interval, weekly → yearly. */
  prices: Record<PlanInterval, PriceView>;
  /** 12 months on monthly minus a year on yearly (null when a price is missing). */
  yearlySavingPence: number | null;
}

/** A pack as customers see it (no internal cost-cap headroom). */
export interface TopUpPricingView extends Pick<
  TopUpPack,
  'lookupKey' | 'kind' | 'quantity' | 'validMonths'
> {
  unitAmountPence: number | null;
}

export interface PricingView {
  catalogueVersion: string;
  currency: typeof PRICING_CURRENCY;
  /** False when Stripe could not be read (prices show as unavailable). */
  available: boolean;
  /** Starter, Growth, Pro (cheapest first: Pro is shown last). */
  plans: PlanPricingView[];
  /** HD video packs (any plan, valid 3 months). */
  topUps: TopUpPricingView[];
  trial: { days: number; videos: number };
  fetchedAt: string;
}

function priceFor(prices: Map<string, PriceState>, key: string): PriceView {
  const price = prices.get(key);
  const ok = price && price.active && price.currency === PRICING_CURRENCY;
  return { lookupKey: key, unitAmountPence: ok ? price.unitAmountPence : null };
}

/** Pure: catalogue + Stripe prices → the view. `prices` null = Stripe unavailable. */
export function buildPricingView(
  prices: readonly PriceState[] | null,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): PricingView {
  const byKey = new Map((prices ?? []).flatMap((p) => (p.lookupKey ? [[p.lookupKey, p]] : [])));
  const plans = PLAN_IDS.map((plan): PlanPricingView => {
    const def = STUDIO_PLANS[plan];
    const byInterval = Object.fromEntries(
      PLAN_INTERVALS.map((interval) => [interval, priceFor(byKey, planLookupKey(plan, interval))]),
    ) as Record<PlanInterval, PriceView>;
    const month = byInterval.month.unitAmountPence;
    const year = byInterval.year.unitAmountPence;
    return {
      plan,
      mostPopular: plan === MOST_POPULAR_PLAN,
      videosPerMonth: def.videosPerMonth,
      videosPerWeek: def.videosPerWeek,
      businesses: def.businesses,
      seats: def.seats,
      prices: byInterval,
      yearlySavingPence: month !== null && year !== null ? Math.max(0, month * 12 - year) : null,
    };
  });
  return {
    catalogueVersion: CATALOGUE_VERSION,
    currency: PRICING_CURRENCY,
    available: prices !== null,
    plans,
    topUps: TOP_UP_PACKS.map((pack) => ({
      lookupKey: pack.lookupKey,
      kind: pack.kind,
      quantity: pack.quantity,
      validMonths: pack.validMonths,
      unitAmountPence: priceFor(byKey, pack.lookupKey).unitAmountPence,
    })),
    trial: { days: trialDays(env), videos: TRIAL.shortVideos },
    fetchedAt: now.toISOString(),
  };
}

export interface PricingSource {
  get(): Promise<PricingView>;
  /** Drop the cache (tests; staff after a price change). */
  clear(): void;
}

export function createPricingSource(options: {
  gateway: StripeGateway | undefined;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
  ttlMs?: number;
  env?: Record<string, string | undefined>;
}): PricingSource {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PRICING_CACHE_TTL_MS;
  let cached: { view: PricingView; at: number } | undefined;
  return {
    async get() {
      if (cached && now() - cached.at < ttlMs) return cached.view;
      let prices: PriceState[] | null = null;
      if (options.gateway) {
        try {
          prices = await options.gateway.listPrices(allLookupKeys());
        } catch (err) {
          options.logger.warn({ err }, 'stripe prices unavailable; pricing shows no amounts');
        }
      }
      const view = buildPricingView(prices, new Date(now()), options.env);
      // A failed read is cached for a minute only, so pricing recovers quickly.
      cached = { view, at: prices === null ? now() - ttlMs + 60_000 : now() };
      return view;
    },
    clear() {
      cached = undefined;
    },
  };
}
