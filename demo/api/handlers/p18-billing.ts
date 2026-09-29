// Phase 18 sample handlers for Track C's billing contract (src/lib/studio/billing/contracts.ts
// BillingService: checkout, portal, invoices), so the pricing and billing screens have data in the
// demo once Track C's screens are in the bundle. Amounts are sample figures, not the live Stripe
// prices; checkout and the portal never leave the demo.
import { DemoHttpError, route } from '../registry';
import { ago, DAY } from './projects-store';

route('GET', '/billing/invoices', () => ({
  data: [2, 1].map((months) => ({
    id: `in_demo_${months}`,
    number: `LSD-000${3 - months}`,
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
