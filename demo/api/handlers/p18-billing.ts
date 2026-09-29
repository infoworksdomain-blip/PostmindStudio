// Phase 18 sample handlers for Track C's billing screens (/pricing, /settings/billing, the upgrade
// dialog): GET /billing, /billing/plans and /billing/invoices with the same envelopes as the API
// (src/app/api/studio/billing/*). Prices are the §P.2 reference amounts through the real
// buildPricingView (billing/test-fixtures.ts), not live Stripe prices. The organisation's plan and
// status come from the demo billing state (../billing-state.ts, the demo bar's plan switcher).
// Checkout and the customer portal never reach Stripe: they answer a hash link to the demo's own
// clearly labelled "Demo checkout (simulated)" page, which collects no card details.
import { pricingView } from '@/components/studio/billing/test-fixtures';
import type { PricingView } from '@/components/studio/billing/types';
import { TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import {
  billingOverview,
  checkoutHref,
  getBillingState,
  invoices,
  setPriceLookup,
} from '../billing-state';
import { DemoHttpError, route } from '../registry';
import { seatsUsed } from './p18-org';

let pricing: PricingView | undefined;

/** The demo's pricing view (reference prices), shared by /pricing and GET /billing/plans. */
export function demoPricing(): PricingView {
  pricing ??= pricingView();
  return pricing;
}

/** Reference price of a plan or top-up lookup key, in pence (0 when unknown). */
export function referencePrice(lookupKey: string): number {
  const view = demoPricing();
  for (const plan of view.plans) {
    for (const price of Object.values(plan.prices)) {
      if (price?.lookupKey === lookupKey) return price.unitAmountPence ?? 0;
    }
  }
  return view.topUps.find((p) => p.lookupKey === lookupKey)?.unitAmountPence ?? 0;
}

setPriceLookup(referencePrice);

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

route('GET', '/billing', () => ({ billing: billingOverview(seatsUsed()) }));

route('GET', '/billing/plans', () => ({ pricing: demoPricing() }));

route('GET', '/billing/invoices', () => ({ invoices: invoices() }));

route('POST', '/billing/checkout', ({ body }) => {
  const input = obj(body);
  if (input.kind === 'topup') {
    const lookupKey = String(input.lookupKey ?? '');
    if (!TOP_UP_PACKS.some((p) => p.lookupKey === lookupKey))
      throw bad('lookupKey: Invalid option');
    if (getBillingState() === 'no_plan')
      throw new DemoHttpError(402, 'plan_required', 'Choose a plan before buying a top-up');
    return { url: checkoutHref({ kind: 'topup', lookupKey }) };
  }
  const tier = input.tier;
  const interval = input.interval;
  if (tier !== 'BASIC' && tier !== 'STANDARD' && tier !== 'PLUS') throw bad('tier: Invalid option');
  if (interval !== 'month' && interval !== 'year') throw bad('interval: Invalid option');
  const state = getBillingState();
  // A live subscription changes plan in the portal, as the real route answers (409).
  if (state !== 'no_plan' && state !== 'cancelled')
    throw new DemoHttpError(409, 'conflict', 'The organisation already has a subscription');
  return { url: checkoutHref({ kind: 'subscription', tier, interval }) };
});

route('POST', '/billing/portal', () => {
  if (getBillingState() === 'no_plan')
    throw new DemoHttpError(409, 'conflict', 'No billing account yet: choose a plan first');
  return { url: checkoutHref({ kind: 'portal' }) };
});
