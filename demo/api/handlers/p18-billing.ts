// Phase 18 / 21.5 sample handlers for the billing screens (/pricing, "Your plan" at
// /settings/billing, the upgrade and add-a-channel dialogs): GET /billing, /billing/plans,
// /billing/invoices and the Your-plan routes (/billing/plan/preview, POST /billing/plan, cancel,
// resume, DELETE /billing/plan/scheduled) with the same envelopes as the API
// (src/app/api/studio/billing/*). Prices are the 21.5 reference amounts (£29 per channel a month,
// £9.50 a week, £290 a year; HD packs 5 for £15 and 15 for £39) through the real buildPricingView
// (billing/test-fixtures.ts), not live Stripe prices. The organisation's plan and status come from
// the demo billing state (../billing-state.ts, the demo bar's plan switcher). Checkout and the
// customer portal never reach Stripe: they answer a hash link to the demo's own clearly labelled
// "Demo checkout (simulated)" page, which collects no card details.
import { pricingView } from '@/components/studio/billing/test-fixtures';
import type { PricingView } from '@/components/studio/billing/types';
import { TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import { allowanceQuartersOf, type AllowanceProject } from '@/lib/studio/ugc/allowance';
import {
  isChannelInterval,
  isValidChannelCount,
  type ChannelPlanChoice,
} from '@/lib/studio/billing/channel-plan';
import {
  billingOverview,
  cancelPlan,
  changePlan,
  checkoutHref,
  getBillingState,
  invoices,
  keepCurrentPlan,
  previewPlanChange,
  resumePlan,
  setConnectionLookup,
  setConnectionPlatformLookup,
  setPriceLookup,
  setProjectQuartersLookup,
} from '../billing-state';
import { DemoHttpError, route } from '../registry';
import { listConnections } from './connections';
import { allProjects } from './projects-store';
import { seatsUsed } from './p18-org';

let pricing: PricingView | undefined;

/** The demo's pricing view (reference prices), shared by /pricing and GET /billing/plans. */
export function demoPricing(): PricingView {
  pricing ??= pricingView();
  return pricing;
}

/** Reference price of a channel price or video-pack lookup key, in pence (0 when unknown). */
export function referencePrice(lookupKey: string): number {
  const view = demoPricing();
  const price =
    view.intervals.find((i) => i.lookupKey === lookupKey)?.unitAmountPence ??
    view.topUps.find((p) => p.lookupKey === lookupKey)?.unitAmountPence;
  return price ?? 0;
}

setPriceLookup(referencePrice);
setConnectionLookup(() =>
  listConnections().map((c) => ({
    platform: c.platform,
    connectedAt: new Date(c.connectedAt),
    state: c.state,
  })),
);
setConnectionPlatformLookup((id) => listConnections().find((c) => c.id === id)?.platform ?? null);
// 23.3: a quick post (carousel, slideshow, wall of text, hook + demo) uses ¼ of a video.
setProjectQuartersLookup((id) => {
  const project = allProjects().find((p) => p.id === id);
  const metadata = (project?.metadata ?? null) as AllowanceProject['metadata'];
  return allowanceQuartersOf({ sourceType: project?.sourceType, metadata });
});

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

/** { channels, interval } from a body or query, validated like the real zod schemas. */
function choiceOf(channels: unknown, interval: unknown): ChannelPlanChoice {
  if (!isValidChannelCount(channels)) throw bad('channels: Choose between 1 and 6 channels');
  if (!isChannelInterval(interval)) throw bad('interval: Invalid option');
  return { channels, interval };
}

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
      throw new DemoHttpError(402, 'plan_required', 'Choose a plan before buying a video pack');
    return { url: checkoutHref({ kind: 'topup', lookupKey }) };
  }
  if (input.kind !== 'channels') throw bad('kind: Invalid option');
  const choice = choiceOf(input.channels, input.interval);
  const state = getBillingState();
  // A live subscription changes on Your plan, as the real route answers (409).
  if (state !== 'no_plan' && state !== 'cancelled')
    throw new DemoHttpError(409, 'conflict', 'The organisation already has a subscription');
  return { url: checkoutHref({ kind: 'channels', ...choice }) };
});

route('POST', '/billing/portal', () => {
  if (getBillingState() === 'no_plan')
    throw new DemoHttpError(409, 'conflict', 'No billing account yet: choose a plan first');
  return { url: checkoutHref({ kind: 'portal' }) };
});

// ------------------------------------------------------------------ Your plan (21.5)

route('GET', '/billing/plan/preview', ({ query }) => {
  const raw = query.get('channels');
  const channels = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  return { preview: previewPlanChange(choiceOf(channels, query.get('interval'))) };
});

route('POST', '/billing/plan', ({ body }) => {
  const input = obj(body);
  return { outcome: changePlan(choiceOf(input.channels, input.interval)) };
});

route('POST', '/billing/plan/cancel', () => cancelPlan());

route('POST', '/billing/plan/resume', () => {
  resumePlan();
  return { resumed: true };
});

route('DELETE', '/billing/plan/scheduled', () => {
  keepCurrentPlan();
  return { cancelled: true };
});
