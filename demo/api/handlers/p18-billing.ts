// Phase 18 / 26.1 sample handlers for the billing screens (/pricing, "Your plan" at
// /settings/billing, the upgrade dialog): GET /billing, /billing/plans, /billing/invoices and the
// Your-plan routes (/billing/plan/preview, POST /billing/plan, cancel, resume, DELETE
// /billing/plan/scheduled) with the same envelopes as the API (src/app/api/studio/billing/*).
// Prices are the 26.1 reference amounts (Starter £29, Growth £69, Pro £149 a month; weekly
// £9.50 / £22.50 / £48.50; yearly 10 × monthly; HD packs 5 for £17 and 15 for £45) through the
// real buildPricingView (billing/test-fixtures.ts), not live Stripe prices. The organisation's plan
// and status come from the demo billing state (../billing-state.ts, the demo bar's plan switcher).
// Checkout and the customer portal never reach Stripe: they answer a hash link to the demo's own
// clearly labelled "Demo checkout (simulated)" page, which collects no card details.
import { pricingView } from '@/components/studio/billing/test-fixtures';
import type { PricingView } from '@/components/studio/billing/types';
import { TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import { allowanceQuartersOf, type AllowanceProject } from '@/lib/studio/ugc/allowance';
import { isPlanId, isPlanInterval, type PlanChoice } from '@/lib/studio/billing/plans';
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
  setPriceLookup,
  setProjectQuartersLookup,
} from '../billing-state';
import { DemoHttpError, route } from '../registry';
import { allProjects } from './projects-store';
import { seatsUsed } from './p18-org';

let pricing: PricingView | undefined;

/** The demo's pricing view (reference prices), shared by /pricing and GET /billing/plans. */
export function demoPricing(): PricingView {
  pricing ??= pricingView();
  return pricing;
}

/** Reference price of a plan price or video-pack lookup key, in pence (0 when unknown). */
export function referencePrice(lookupKey: string): number {
  const view = demoPricing();
  const price =
    view.plans.flatMap((p) => Object.values(p.prices)).find((p) => p.lookupKey === lookupKey)
      ?.unitAmountPence ?? view.topUps.find((p) => p.lookupKey === lookupKey)?.unitAmountPence;
  return price ?? 0;
}

setPriceLookup(referencePrice);
// 23.3: a quick post (carousel, slideshow, wall of text, hook + demo) uses ¼ of a video.
setProjectQuartersLookup((id) => {
  const project = allProjects().find((p) => p.id === id);
  const metadata = (project?.metadata ?? null) as AllowanceProject['metadata'];
  return allowanceQuartersOf({ sourceType: project?.sourceType, metadata });
});

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bad = (message: string) => new DemoHttpError(400, 'validation_error', message);

/** { plan, interval } from a body or query, validated like the real zod schemas. */
function choiceOf(plan: unknown, interval: unknown): PlanChoice {
  if (!isPlanId(plan)) throw bad('plan: Invalid option');
  if (!isPlanInterval(interval)) throw bad('interval: Invalid option');
  return { plan, interval };
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
  if (input.kind !== 'plan') throw bad('kind: Invalid option');
  const choice = choiceOf(input.plan, input.interval);
  const state = getBillingState();
  // A live subscription changes on Your plan, as the real route answers (409).
  if (state !== 'no_plan' && state !== 'cancelled')
    throw new DemoHttpError(409, 'conflict', 'The organisation already has a subscription');
  return { url: checkoutHref({ kind: 'plan', ...choice }) };
});

route('POST', '/billing/portal', () => {
  if (getBillingState() === 'no_plan')
    throw new DemoHttpError(409, 'conflict', 'No billing account yet: choose a plan first');
  return { url: checkoutHref({ kind: 'portal' }) };
});

// ------------------------------------------------------------------ Your plan (26.1)

route('GET', '/billing/plan/preview', ({ query }) => ({
  preview: previewPlanChange(choiceOf(query.get('plan'), query.get('interval'))),
}));

route('POST', '/billing/plan', ({ body }) => {
  const input = obj(body);
  return { outcome: changePlan(choiceOf(input.plan, input.interval)) };
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
