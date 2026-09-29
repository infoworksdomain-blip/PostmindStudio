import type { Logger } from 'pino';
import {
  allLookupKeys,
  CATALOGUE_VERSION,
  PLAN_CATALOGUE,
  TIER_ORDER,
  TOP_UP_PACKS,
  TRIAL,
  type BillingInterval,
  type PlanDefinition,
  type TopUpPack,
} from './catalogue';
import { trialDays } from './entitlements';
import type { PriceState, StripeGateway } from './gateway';
import type { PlanTier } from '../providers/router';

// Phase 18 §2.7 / §P.4 — what /pricing, the upgrade dialog and /settings/billing show. Amounts
// come from Stripe by lookup key (prices.list lookup_keys + expand data.product), cached for
// 10 minutes, so the operator changes a price in Stripe (new Price + transfer_lookup_key) with no
// deploy. Everything else comes from the catalogue. A missing or non-GBP price shows as
// "unavailable" rather than a made-up number.

export const PRICING_CACHE_TTL_MS = 10 * 60_000;
export const PRICING_CURRENCY = 'gbp';

export interface PriceView {
  lookupKey: string;
  /** null = no active GBP price with this lookup key in Stripe. */
  unitAmountPence: number | null;
}

export interface PlanPricingView {
  tier: PlanTier;
  selfServe: boolean;
  displayOrder: number;
  trialDays: number;
  prices: Partial<Record<BillingInterval, PriceView>>;
  /** Annual saving versus 12 monthly payments, in pence (null when either price is missing). */
  annualSavingPence: number | null;
  features: PlanDefinition;
}

export interface TopUpPricingView extends TopUpPack {
  unitAmountPence: number | null;
}

export interface PricingView {
  catalogueVersion: string;
  currency: typeof PRICING_CURRENCY;
  /** False when Stripe could not be read (prices show as unavailable). */
  available: boolean;
  plans: PlanPricingView[];
  topUps: TopUpPricingView[];
  trial: { tier: PlanTier; days: number; shortVideos: number; longVideos: number };
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
  const days = trialDays(env);
  const plans = TIER_ORDER.map((tier): PlanPricingView => {
    const plan = PLAN_CATALOGUE[tier];
    const entries = Object.entries(plan.lookupKeys) as [BillingInterval, string][];
    const views = Object.fromEntries(entries.map(([i, key]) => [i, priceFor(byKey, key)]));
    const month = views.month?.unitAmountPence;
    const year = views.year?.unitAmountPence;
    return {
      tier,
      selfServe: plan.selfServe,
      displayOrder: plan.displayOrder,
      trialDays: plan.trialDays > 0 ? days : 0,
      prices: views,
      annualSavingPence: month != null && year != null ? Math.max(0, month * 12 - year) : null,
      features: plan,
    };
  });
  return {
    catalogueVersion: CATALOGUE_VERSION,
    currency: PRICING_CURRENCY,
    available: prices !== null,
    plans,
    topUps: TOP_UP_PACKS.map((pack) => ({
      ...pack,
      unitAmountPence: priceFor(byKey, pack.lookupKey).unitAmountPence,
    })),
    trial: {
      tier: TRIAL.tier,
      days,
      shortVideos: TRIAL.shortVideos,
      longVideos: TRIAL.longVideos,
    },
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
