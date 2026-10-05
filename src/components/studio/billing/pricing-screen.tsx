'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { PageHeader } from '../primitives';
import { ChannelPicker, usePackName, type ChannelChoice } from './channel-picker';
import type { PricingView } from './types';

// Phase 18 §3 / 21.5 — public /pricing: ONE plan. Choose how many channels (social platforms,
// 1–6) and how often to pay (weekly, monthly, yearly); the page shows the total for the period,
// "8 videos per channel per month included", what every plan includes, the HD video packs and an
// FAQ. Amounts come from Stripe through PricingView; when Stripe is unreachable every amount reads
// "Price unavailable". "Start free trial" goes to sign-up, then to Your plan with the same choice.
// No generation cost or budget is shown.

const INCLUDED = ['videos', 'hd', 'platforms', 'scheduling', 'brand', 'library'] as const;
const FAQ = ['channel', 'period', 'change', 'limit', 'packs', 'vat', 'cancel'] as const;

/** Where "Start" goes: sign up, then Your plan with the channels and period already chosen. */
export function signUpHref(choice: ChannelChoice): string {
  const next = `/settings/billing?channels=${choice.channels}&interval=${choice.interval}`;
  return `/sign-up?next=${encodeURIComponent(next)}`;
}

function Included() {
  const t = useTranslations('pricing.included');
  return (
    <section aria-labelledby="included-heading" className="grid gap-4">
      <h2 id="included-heading" className="font-display text-3xl leading-none">
        {t('title')}
      </h2>
      <ul className="grid gap-2 text-sm sm:grid-cols-2">
        {INCLUDED.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            {t(`items.${item}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Packs({ pricing }: { pricing: PricingView }) {
  const t = useTranslations('pricing.packs');
  const tPlan = useTranslations('channelPlan');
  const f = useFormat();
  const name = usePackName();
  return (
    <section aria-labelledby="packs-heading" className="grid gap-4">
      <div className="grid gap-1.5">
        <h2 id="packs-heading" className="font-display text-3xl leading-none">
          {t('title')}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {pricing.topUps.map((pack) => (
          <li key={pack.lookupKey} className="grid gap-1 rounded-xl border border-border p-4">
            <p className="font-medium">{name(pack)}</p>
            <p className="font-display text-2xl tabular-nums">
              {pack.unitAmountPence === null
                ? tPlan('priceUnavailable')
                : f.pence(pack.unitAmountPence)}
            </p>
            <p className="text-xs text-muted-foreground">
              {tPlan('packs.validity', { months: pack.validMonths })}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Faq({ pricing }: { pricing: PricingView }) {
  const t = useTranslations('pricing.faq');
  const tPlan = useTranslations('channelPlan');
  const f = useFormat();
  const amount = (interval: 'week' | 'month' | 'year') => {
    const pence = pricing.intervals.find((i) => i.interval === interval)?.unitAmountPence;
    return pence == null ? tPlan('priceUnavailable') : f.pence(pence);
  };
  const prices = { weekly: amount('week'), monthly: amount('month'), yearly: amount('year') };
  return (
    <section aria-labelledby="faq-heading" className="grid gap-4">
      <h2 id="faq-heading" className="font-display text-3xl leading-none">
        {t('title')}
      </h2>
      <div className="divide-y divide-border rounded-xl border border-border">
        {FAQ.map((item) => (
          <details key={item} className="group p-4">
            <summary className="cursor-pointer font-medium">{t(`items.${item}.q`)}</summary>
            <p className="mt-2 text-sm text-muted-foreground">
              {item === 'period' ? t('items.period.a', prices) : t(`items.${item}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function PricingScreen({ pricing }: { pricing: PricingView }) {
  const t = useTranslations('pricing');
  const [choice, setChoice] = useState<ChannelChoice>({ channels: 3, interval: 'month' });
  const trial = pricing.trial.days > 0;
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-12 px-4 py-10 md:px-8 md:py-16">
      <PageHeader
        eyebrow={t('hero.eyebrow')}
        title={t('hero.title')}
        description={t('hero.description')}
      />
      <section
        aria-labelledby="plan-heading"
        className="grid gap-6 rounded-2xl border border-primary bg-card p-5 shadow-lg shadow-primary/10 md:p-8"
      >
        <h2 id="plan-heading" className="font-display text-2xl leading-none">
          {t('plan.title')}
        </h2>
        {!pricing.available && (
          <p
            role="status"
            className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm"
          >
            {t('unavailable')}
          </p>
        )}
        <ChannelPicker id="pricing" value={choice} onChange={setChoice} pricing={pricing} />
        <div className="grid gap-2">
          <Button asChild size="lg" className="w-full sm:w-auto sm:justify-self-start">
            <Link href={signUpHref(choice)}>
              {trial ? t('cta.trial') : t('cta.start')}
              <ArrowRight className="rtl:-scale-x-100" aria-hidden />
            </Link>
          </Button>
          {trial && (
            <p className="text-sm text-muted-foreground">
              {t('trialNote', { days: pricing.trial.days, videos: pricing.trial.videos })}
            </p>
          )}
        </div>
      </section>
      <Included />
      <Packs pricing={pricing} />
      <Faq pricing={pricing} />
    </div>
  );
}
