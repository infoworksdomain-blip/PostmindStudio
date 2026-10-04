import type { Logger } from 'pino';
import { allLookupKeys, CATALOGUE_VERSION, TOP_UP_PACKS, TRIAL, type TopUpPack } from './catalogue';
import {
  CHANNEL_INTERVALS,
  CHANNEL_LOOKUP_KEYS,
  MAX_CHANNELS,
  MIN_CHANNELS,
  VIDEOS_PER_CHANNEL_PER_PERIOD,
  type ChannelInterval,
} from './channel-plan';
import { trialDays } from './entitlements';
import type { PriceState, StripeGateway } from './gateway';

// Phase 18 §2.7 / 21.5 — what /pricing, sign-up plan selection, the upgrade dialog and "Your plan"
// show: the per-channel price of each interval (weekly, monthly, yearly), the videos included and
// the HD video packs. Amounts come from Stripe by lookup key (prices.list lookup_keys + expand
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

export interface ChannelIntervalView extends PriceView {
  interval: ChannelInterval;
  /** Videos included per channel per billing period (2 a week, 8 a month, 96 a year). */
  videosPerChannel: number;
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
  channels: { min: number; max: number };
  /** The per-channel price of each interval, weekly → yearly. */
  intervals: ChannelIntervalView[];
  /** 12 months on monthly minus a year on yearly, per channel (null when a price is missing). */
  yearlySavingPerChannelPence: number | null;
  /** HD video packs (any channel, valid 3 months). */
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
  const intervals = CHANNEL_INTERVALS.map((interval): ChannelIntervalView => ({
    interval,
    ...priceFor(byKey, CHANNEL_LOOKUP_KEYS[interval]),
    videosPerChannel: VIDEOS_PER_CHANNEL_PER_PERIOD[interval],
  }));
  const month = intervals.find((i) => i.interval === 'month')?.unitAmountPence ?? null;
  const year = intervals.find((i) => i.interval === 'year')?.unitAmountPence ?? null;
  return {
    catalogueVersion: CATALOGUE_VERSION,
    currency: PRICING_CURRENCY,
    available: prices !== null,
    channels: { min: MIN_CHANNELS, max: MAX_CHANNELS },
    intervals,
    yearlySavingPerChannelPence:
      month !== null && year !== null ? Math.max(0, month * 12 - year) : null,
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
