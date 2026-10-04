'use client';

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { BillingInterval, PlanPricingView, TopUpPricingView } from './types';

// Phase 18 §P.4 — building blocks shared by /pricing and the plan picker on /settings/billing:
// the monthly / annual switch, a plan's price for the chosen interval (from Stripe, or "price
// unavailable" — never an invented number), its headline allowances, and the plan card grid.

export function IntervalToggle({
  value,
  onChange,
}: {
  value: BillingInterval;
  onChange: (next: BillingInterval) => void;
}) {
  const t = useTranslations('pricing.interval');
  const options: BillingInterval[] = ['month', 'year'];
  return (
    <div
      role="radiogroup"
      aria-label={t('label')}
      className="inline-flex rounded-full border border-border bg-card p-1 text-sm"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-full px-4 py-1.5 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            value === option
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(option)}
        </button>
      ))}
    </div>
  );
}

export function PlanPrice({
  plan,
  interval,
}: {
  plan: PlanPricingView;
  interval: BillingInterval;
}) {
  const t = useTranslations('pricing');
  const f = useFormat();
  const amount = plan.prices[interval]?.unitAmountPence ?? null;
  if (amount === null)
    return <p className="text-sm font-medium text-muted-foreground">{t('priceUnavailable')}</p>;
  const saving = interval === 'year' ? plan.annualSavingPence : null;
  return (
    <div className="grid gap-1">
      <p className="font-display text-3xl leading-none tabular-nums">
        {interval === 'month'
          ? t('perMonth', { amount: f.pence(amount) })
          : t('perYear', { amount: f.pence(amount) })}
      </p>
      {saving !== null && saving > 0 && (
        <p className="text-xs font-medium text-success">
          {t('annualSaving', { amount: f.pence(saving) })}
        </p>
      )}
    </div>
  );
}

export function PlanHighlights({ plan }: { plan: PlanPricingView }) {
  const t = useTranslations('pricing.highlights');
  const p = plan.features;
  const items: string[] =
    p.shortVideosPerMonth === null
      ? [t('unlimitedVideos')]
      : [
          t('shortVideos', { count: p.shortVideosPerMonth }),
          p.longVideosPerMonth
            ? t('longVideos', { count: p.longVideosPerMonth })
            : t('noLongVideos'),
          ...(p.seats === null ? [] : [t('seats', { count: p.seats })]),
          ...(p.businesses === null ? [] : [t('businesses', { count: p.businesses })]),
        ];
  return (
    <ul className="grid gap-1.5 text-sm">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** The tier cards; `cta` renders each card's action (a sign-up link, a Checkout button…). */
export function PlanCards({
  plans,
  interval,
  cta,
  highlightTier = 'STANDARD',
}: {
  plans: readonly PlanPricingView[];
  interval: BillingInterval;
  cta: (plan: PlanPricingView) => ReactNode;
  highlightTier?: string;
}) {
  const t = useTranslations('pricing');
  const tTier = useTranslations('shell.usage.tiers');
  const sorted = [...plans].sort((a, b) => a.displayOrder - b.displayOrder);
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {sorted.map((plan) => {
        const popular = plan.tier === highlightTier;
        return (
          <li
            key={plan.tier}
            aria-labelledby={`plan-${plan.tier}`}
            className={cn(
              'relative flex flex-col gap-5 rounded-2xl border bg-card p-6',
              popular ? 'border-primary shadow-lg shadow-primary/10' : 'border-border',
            )}
          >
            {popular && (
              <span className="absolute -top-3 start-6 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                {t('popular')}
              </span>
            )}
            <div className="grid gap-1.5">
              <h3 id={`plan-${plan.tier}`} className="font-display text-2xl leading-none">
                {tTier(plan.tier)}
              </h3>
              <p className="text-sm text-muted-foreground">{t(`tiers.${plan.tier}.tagline`)}</p>
            </div>
            {plan.selfServe ? (
              <PlanPrice plan={plan} interval={interval} />
            ) : (
              <p className="font-display text-3xl leading-none">{t('enterprise.price')}</p>
            )}
            <PlanHighlights plan={plan} />
            <div className="mt-auto">{cta(plan)}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** "10 short videos" / "2 long videos" for a top-up pack. */
export function useTopUpName(): (pack: Pick<TopUpPricingView, 'kind' | 'quantity'>) => string {
  const t = useTranslations('pricing.topUps');
  return (pack) =>
    pack.kind === 'short'
      ? t('short', { quantity: pack.quantity })
      : t('long', { quantity: pack.quantity });
}
