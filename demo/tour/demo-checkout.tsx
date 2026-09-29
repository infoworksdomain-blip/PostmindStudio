import { useState, type ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { PLAN_CATALOGUE, TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import { Button } from '@/components/ui/button';
import { useBillingState } from './billing-switcher';
import {
  completeCheckout,
  isCancelling,
  parseCheckoutIntent,
  portalCancel,
  portalChangePlan,
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
// would (the plan starts, or the top-up credits arrive), then returns to /settings/billing.

const TIER_NAME = { BASIC: 'Basic', STANDARD: 'Standard', PLUS: 'Plus' } as const;

const money = (pence: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);

function packName(lookupKey: string): string {
  const pack = TOP_UP_PACKS.find((p) => p.lookupKey === lookupKey);
  if (!pack) return lookupKey;
  const what = pack.kind === 'short' ? 'short videos' : 'long videos';
  return `${pack.quantity} ${what} top-up (${TIER_NAME[pack.tier as keyof typeof TIER_NAME] ?? pack.tier})`;
}

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

function Checkout({ intent }: { intent: Exclude<DemoCheckoutIntent, { kind: 'portal' }> }) {
  const [busy, setBusy] = useState(false);
  const back = intent.kind === 'topup' ? 'topup' : 'checkout';
  let lines: Array<[string, string]>;
  if (intent.kind === 'topup') {
    lines = [
      ['Item', packName(intent.lookupKey)],
      ['Price (one-off, excl. VAT)', money(referencePrice(intent.lookupKey))],
      ['Credits valid for', '12 months'],
    ];
  } else {
    const key = PLAN_CATALOGUE[intent.tier].lookupKeys[intent.interval] ?? '';
    const price = money(referencePrice(key));
    const per = intent.interval === 'year' ? 'year' : 'month';
    lines = [
      [
        'Plan',
        `${TIER_NAME[intent.tier]}, billed ${intent.interval === 'year' ? 'annually' : 'monthly'}`,
      ],
      [`Price per ${per} (excl. VAT)`, price],
      ...(startsTrial(intent.tier)
        ? ([
            ['Due today', money(0)],
            ['Trial', `14 days, then ${price} a ${per}`],
          ] as Array<[string, string]>)
        : []),
    ];
  }
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
        {lines.map(([label, value]) => (
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
  const cancelling = isCancelling();
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
        {state !== 'enterprise' && (
          <div className="grid gap-2">
            <h2 className="text-sm font-semibold">Change plan</h2>
            <p className="text-sm text-muted-foreground">
              Upgrades apply now and are charged pro rata; downgrades apply at the end of the
              period.
            </p>
            <div className="flex flex-wrap gap-2">
              {(['BASIC', 'STANDARD', 'PLUS'] as const).map((tier) => (
                <Button
                  key={tier}
                  variant="outline"
                  size="sm"
                  disabled={!unpaid && info.tier === tier}
                  onClick={done(() => portalChangePlan(tier))}
                >
                  Switch to {TIER_NAME[tier]}
                </Button>
              ))}
            </div>
          </div>
        )}
        {info.status === 'active' && state !== 'enterprise' && (
          <div className="grid gap-2">
            <h2 className="text-sm font-semibold">Cancel plan</h2>
            <p className="text-sm text-muted-foreground">
              Full access until the end of the period, then read-only; the data is kept for 90 days.
            </p>
            <Button
              variant="outline"
              className="justify-self-start"
              disabled={cancelling}
              onClick={done(portalCancel)}
            >
              {cancelling ? 'Cancels at period end' : 'Cancel at period end'}
            </Button>
          </div>
        )}
        <a
          href="#/settings/billing"
          className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to billing
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
          Nothing to pay for here. Choose a plan or a top-up on{' '}
          <a className="underline underline-offset-4" href="#/settings/billing">
            Billing
          </a>
          .
        </p>
      </Frame>
    );
  return intent.kind === 'portal' ? <Portal /> : <Checkout intent={intent} />;
}
