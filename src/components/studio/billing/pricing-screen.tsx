'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import { videosToQuarters } from '@/lib/studio/billing/allowance-units';
import { PLAN_NAMES } from '@/lib/studio/billing/plans';
import { orderedPlans, PlanPicker, usePackName } from './plan-picker';
import type { PlanChoice, PricingView } from './types';

// Phase 18 §3 / 26.1 — public /pricing: three plans, Starter, Growth (most popular) and Pro, each
// posting to every platform. Choose a plan and how often to pay (weekly, monthly, yearly); each
// plan shows its price for the period, its HD videos, businesses and seats; then what every plan
// includes, the HD video packs and an FAQ. Amounts come from Stripe through PricingView; when Stripe is unreachable every amount reads
// "Price unavailable". "Start free trial" goes to sign-up, then to Your plan with the same choice.
// No generation cost or budget is shown.

// 23.3: quick posts (carousels, slideshows, text videos) count as ¼ of a video.
const INCLUDED = ['quickPosts', 'hd', 'platforms', 'scheduling', 'brand', 'library'] as const;
const FAQ = [
  'platforms',
  'period',
  'change',
  'quickPosts',
  'limit',
  'packs',
  'vat',
  'cancel',
] as const;

/** Where "Start" goes: sign up, then Your plan with the plan and period already chosen. */
export function signUpHref(choice: PlanChoice): string {
  const next = `/settings/billing?plan=${choice.plan}&interval=${choice.interval}`;
  return `/sign-up?next=${encodeURIComponent(next)}`;
}

function Included() {
  const t = useTranslations('pricing.included');
  return (
    <section aria-labelledby="included-heading" className="grid gap-4">
      <h2 id="included-heading" className="font-display text-2xl md:text-3xl">
        {t('title')}
      </h2>
      <ul className="grid gap-x-10 border-t border-border sm:grid-cols-2">
        {INCLUDED.map((item) => (
          <li key={item} className="flex items-start gap-2.5 border-b border-border py-3.5 text-sm">
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
  const tPlan = useTranslations('planPicker');
  const f = useFormat();
  const name = usePackName();
  return (
    <section aria-labelledby="packs-heading" className="grid gap-4">
      <div className="grid gap-1.5">
        <h2 id="packs-heading" className="font-display text-2xl md:text-3xl">
          {t('title')}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {pricing.topUps.map((pack) => (
          <li
            key={pack.lookupKey}
            className="grid gap-1 rounded-panel bg-surface-raised p-5 ring-1 ring-border"
          >
            <p className="font-medium">{name(pack)}</p>
            <p className="font-display text-3xl tabular-nums">
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
  const tPlan = useTranslations('planPicker');
  const f = useFormat();
  // The period and quick-post answers quote the cheapest plan (live prices, its HD videos).
  const cheapest = orderedPlans(pricing)[0];
  const planName = cheapest ? PLAN_NAMES[cheapest.plan] : '';
  const videos = cheapest?.videosPerMonth ?? 0;
  const amount = (interval: 'week' | 'month' | 'year') => {
    const pence = cheapest?.prices[interval].unitAmountPence;
    return pence == null ? tPlan('priceUnavailable') : f.pence(pence);
  };
  const prices = {
    plan: planName,
    weekly: amount('week'),
    monthly: amount('month'),
    yearly: amount('year'),
  };
  return (
    <section aria-labelledby="faq-heading" className="grid gap-4">
      <h2 id="faq-heading" className="font-display text-2xl md:text-3xl">
        {t('title')}
      </h2>
      <div className="divide-y divide-border border-y border-border">
        {FAQ.map((item) => (
          <details key={item} className="group py-5">
            <summary className="cursor-pointer font-medium marker:text-muted-foreground">
              {t(`items.${item}.q`)}
            </summary>
            <p className="mt-2 max-w-3xl text-[0.9375rem] leading-relaxed text-muted-foreground">
              {item === 'period'
                ? t('items.period.a', prices)
                : item === 'quickPosts'
                  ? t('items.quickPosts.a', {
                      plan: planName,
                      videos,
                      quick: videosToQuarters(videos),
                    })
                  : t(`items.${item}.a`)}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function PricingScreen({ pricing }: { pricing: PricingView }) {
  const t = useTranslations('pricing');
  const [choice, setChoice] = useState<PlanChoice>({ plan: 'growth', interval: 'month' });
  const trial = pricing.trial.days > 0;
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-16 px-4 py-14 md:px-8 md:py-20">
      <header className="max-w-3xl">
        <p className="inline-flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          <span aria-hidden className="size-2 rounded-full bg-primary" />
          {t('hero.eyebrow')}
        </p>
        <h1 className="mt-5 font-display text-[clamp(2.5rem,1.6rem+3vw,4rem)] leading-[1.02] text-balance">
          {t('hero.title')}
        </h1>
        <p className="mt-5 text-lg text-pretty text-muted-foreground">{t('hero.description')}</p>
      </header>
      <section
        aria-labelledby="plan-heading"
        className="grid gap-6 rounded-[1.75rem] bg-surface-raised p-6 shadow-raised ring-1 ring-border md:p-10"
      >
        <h2 id="plan-heading" className="font-display text-2xl">
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
        <PlanPicker id="pricing" value={choice} onChange={setChoice} pricing={pricing} />
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
