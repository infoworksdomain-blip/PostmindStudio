// Phase 18 sample handlers for Track C's billing screens (/pricing, /settings/billing, the upgrade
// dialog): GET /billing, /billing/plans and /billing/invoices with the same envelopes as the API
// (src/app/api/studio/billing/*). Prices are the §P.2 reference amounts through the real
// buildPricingView (billing/test-fixtures.ts), not live Stripe prices; checkout and the portal
// never leave the demo.
import { billing, pricingView } from '@/components/studio/billing/test-fixtures';
import type { PricingView } from '@/components/studio/billing/types';
import { DemoHttpError, route } from '../registry';
import { ago, DAY } from './projects-store';

let pricing: PricingView | undefined;

/** The demo's pricing view (reference prices), shared by /pricing and GET /billing/plans. */
export function demoPricing(): PricingView {
  pricing ??= pricingView();
  return pricing;
}

route('GET', '/billing', () => {
  // The demo organisation: a Standard trial with 9 days left (the AppShell's trial banner, from
  // GET /me in p18-org.ts, says the same), 7 short-video top-up credits.
  const trialEnd = new Date(Date.now() + 9 * DAY - 3_600_000).toISOString();
  const sample = billing();
  return {
    billing: billing({
      entitlements: { ...sample.entitlements, subscriptionStatus: 'trialing' },
      subscription: {
        status: 'trialing',
        lookupKey: 'studio_standard_monthly',
        interval: 'month',
        currentPeriodEnd: trialEnd,
        cancelAtPeriodEnd: false,
        trialEnd,
      },
    }),
  };
});

route('GET', '/billing/plans', () => ({ pricing: demoPricing() }));

route('GET', '/billing/invoices', () => ({
  invoices: [1, 2, 3].map((months) => ({
    id: `in_demo_${months}`,
    number: `LSD-000${4 - months}`,
    status: 'paid',
    amountDuePence: 4_900,
    currency: 'gbp',
    createdAt: ago(months * 30 * DAY),
    hostedInvoiceUrl: null,
    invoicePdfUrl: null,
  })),
}));

route('POST', '/billing/checkout', () => {
  throw new DemoHttpError(403, 'forbidden', 'Stripe Checkout does not open from the demo.');
});

route('POST', '/billing/portal', () => {
  throw new DemoHttpError(
    403,
    'forbidden',
    'The Stripe customer portal does not open from the demo.',
  );
});
