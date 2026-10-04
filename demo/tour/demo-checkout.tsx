import { useState, type ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import {
  CHANNEL_LOOKUP_KEYS,
  VIDEOS_PER_CHANNEL_PER_PERIOD,
  type ChannelInterval,
} from '@/lib/studio/billing/channel-plan';
import { Button } from '@/components/ui/button';
import { useBillingState } from './billing-switcher';
import {
  completeCheckout,
  parseCheckoutIntent,
  portalUpdatePayment,
  startsTrial,
  BILLING_STATE_INFO,
  type DemoCheckoutIntent,
} from '../api/billing-state';
import { referencePrice } from '../api/handlers/p18-billing';
import { navigate } from '../router';

// #/demo-checkout — what the demo shows where the live app sends the browser to Stripe Checkout
// or the Customer Portal. It is plainly a simulation: its own neutral styling (no Stripe branding),
// no card or bank fields, and one "Complete demo payment" button that does what the paid webhook
// would (the channel plan starts, or the video-pack credits arrive), then returns to
// /settings/billing. 21.5: plan changes and cancelling happen on Your plan, so the simulated
// portal only covers the payment method and invoices.

const money = (pence: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

const PER: Readonly<Record<ChannelInterval, string>> = {
  week: 'week',
  month: 'month',
  year: 'year',
};
const BILLED: Readonly<Record<ChannelInterval, string>> = {
  week: 'weekly',
  month: 'monthly',
  year: 'yearly, paid upfront',
};

function packName(lookupKey: string): string {
  const pack = TOP_UP_PACKS.find((p) => p.lookupKey === lookupKey);
  return pack ? `HD video pack: ${pack.quantity} videos, any channel` : lookupKey;
}

const channelsText = (n: number) => `${n} ${n === 1 ? 'channel' : 'channels'}`;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main lang="en" dir="ltr" className="flex min-h-dvh justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-lg">
        <p
          role="note"
          className="mb-4 flex items-start gap-2 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5 p-3 text-sm"
        >
          <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            <strong className="font-semibold">Simulated.</strong> This page stands in for the
            payment page. It collects no card or bank details and nothing is charged.
          </span>
        </p>
        <section
          aria-labelledby="demo-checkout-title"
          className="rounded-xl border border-border bg-card p-6 shadow-sm"
        >
          <h1 id="demo-checkout-title" className="font-display text-3xl leading-tight">
            {title}
          </h1>
          {children}
        </section>
      </div>
    </main>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/70 py-2 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function checkoutLines(intent: Exclude<DemoCheckoutIntent, { kind: 'portal' }>) {
  if (intent.kind === 'topup') {
    const pack = TOP_UP_PACKS.find((p) => p.lookupKey === intent.lookupKey);
    return [
      ['Item', packName(intent.lookupKey)],
      ['Price (one-off, excl. VAT)', money(referencePrice(intent.lookupKey))],
      ['Videos valid for', `${pack?.validMonths ?? 3} months`],
    ] as Array<[string, string]>;
  }
  const { channels, interval } = intent;
  const per = PER[interval];
  const unit = referencePrice(CHANNEL_LOOKUP_KEYS[interval]);
  const total = money(unit * channels);
  const videos = VIDEOS_PER_CHANNEL_PER_PERIOD[interval] * channels;
  const lines: Array<[string, string]> = [
    ['Plan', `${channelsText(channels)}, billed ${BILLED[interval]}`],
    ['Price per channel (excl. VAT)', `${money(unit)} a ${per}`],
    [`Total per ${per} (excl. VAT)`, total],
    ['Videos included', `${videos} a ${per}`],
  ];
  if (startsTrial())
    lines.push(['Due today', money(0)], ['Trial', `14 days with 5 videos, then ${total} a ${per}`]);
  return lines;
}

function Checkout({ intent }: { intent: Exclude<DemoCheckoutIntent, { kind: 'portal' }> }) {
  const [busy, setBusy] = useState(false);
  const back = intent.kind === 'topup' ? 'topup' : 'checkout';
  const complete = () => {
    setBusy(true);
    const kind = completeCheckout(intent);
    navigate(`/settings/billing?${kind}=success`);
  };
  return (
    <Frame title="Demo checkout (simulated)">
      <p className="mt-2 text-sm text-muted-foreground">
        For Leeds Sourdough Ltd (sample organisation). In the live app this step is Stripe Checkout.
      </p>
      <dl className="mt-5">
        {checkoutLines(intent).map(([label, value]) => (
          <Line key={label} label={label} value={value} />
        ))}
      </dl>
      <div className="mt-6 grid gap-3">
        <Button className="h-10 w-full" onClick={complete} disabled={busy}>
          Complete demo payment
        </Button>
        <a
          href={`#/settings/billing?${back}=cancelled`}
          className="justify-self-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Cancel and go back
        </a>
      </div>
    </Frame>
  );
}

function Portal() {
  const state = useBillingState();
  const info = BILLING_STATE_INFO[state];
  const done = (fn: () => void) => () => {
    fn();
    navigate('/settings/billing');
  };
  const unpaid = state === 'past_due' || state === 'read_only' || state === 'cancelled';
  return (
    <Frame title="Demo billing portal (simulated)">
      <p className="mt-2 text-sm text-muted-foreground">
        Leeds Sourdough Ltd · {info.label}. In the live app this is the Stripe Customer Portal.
      </p>
      <div className="mt-6 grid gap-6">
        <div className="grid gap-2">
          <h2 className="text-sm font-semibold">Payment method</h2>
          <p className="text-sm text-muted-foreground">
            {unpaid
              ? 'The last payment failed. Updating the payment method pays the open invoice and restores full access at once.'
              : 'A sample payment method is on file. No card details are shown or collected here.'}
          </p>
          <Button
            variant={unpaid ? 'default' : 'outline'}
            className="justify-self-start"
            onClick={done(portalUpdatePayment)}
          >
            Update payment method (simulated)
          </Button>
        </div>
        <div className="grid gap-2">
          <h2 className="text-sm font-semibold">Invoices</h2>
          <p className="text-sm text-muted-foreground">
            Past invoices are listed on Your plan. Channels, how often you pay and cancelling are
            changed there too, not in this portal.
          </p>
        </div>
        <a
          href="#/settings/billing"
          className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Your plan
        </a>
      </div>
    </Frame>
  );
}

export function DemoCheckout({ search }: { search: URLSearchParams }) {
  const intent = parseCheckoutIntent(search);
  if (!intent)
    return (
      <Frame title="Demo checkout (simulated)">
        <p className="mt-3 text-sm text-muted-foreground">
          Nothing to pay for here. Choose your channels or a video pack on{' '}
          <a className="underline underline-offset-4" href="#/settings/billing">
            Your plan
          </a>
          .
        </p>
      </Frame>
    );
  return intent.kind === 'portal' ? <Portal /> : <Checkout intent={intent} />;
}
