import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { formatNumber } from '@/lib/client/format';
import { REFERENCE_PRICES_PENCE, TOP_UP_PACKS } from '@/lib/studio/billing/catalogue';
import {
  MOST_POPULAR_PLAN,
  PLAN_IDS,
  PLAN_NAMES,
  planPricePence,
  STUDIO_PLANS,
} from '@/lib/studio/billing/plans';
import { cn } from '@/lib/utils';
import { Band, Container, Eyebrow, Lede, ProductShot, SectionTitle } from './primitives';

// 25.5 §7–§10 — analytics (the real screen), brand kit and approvals (the image library screen),
// the pricing teaser and the closing call to action. The teaser's numbers come from the plans
// (plans.ts: Starter, Growth, Pro a month with their HD videos; Growth is the most popular) and
// the pack reference amounts (catalogue.ts), so they cannot drift from what Stripe is seeded with;
// live amounts are on /pricing, read from Stripe.

export function Insights() {
  const t = useTranslations('marketing.insights');
  return (
    <Band labelledBy="insights-title" className="border-t border-border">
      <Container className="grid items-center gap-x-16 gap-y-12 lg:grid-cols-[1.35fr_1fr]">
        <div data-reveal>
          <ProductShot screen="analytics" alt={t('alt')} />
        </div>
        <div data-reveal>
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <SectionTitle id="insights-title">{t('title')}</SectionTitle>
          <Lede>{t('body')}</Lede>
        </div>
      </Container>
    </Band>
  );
}

export function BrandAndApprovals() {
  const t = useTranslations('marketing.brand');
  return (
    <Band labelledBy="brand-title" className="border-t border-border">
      <Container>
        <div data-reveal className="max-w-3xl">
          <Eyebrow>{t('eyebrow')}</Eyebrow>
          <SectionTitle id="brand-title">{t('title')}</SectionTitle>
        </div>
        <div className="mt-14 grid items-start gap-x-16 gap-y-12 lg:grid-cols-[1fr_1.35fr]">
          <dl className="grid">
            {(['brand', 'approvals', 'languages'] as const).map((k) => (
              <div key={k} data-reveal className="border-t border-border py-6 first:pt-6">
                <dt className="text-lg font-semibold">{t(`items.${k}.title`)}</dt>
                <dd className="mt-1.5 text-muted-foreground">{t(`items.${k}.body`)}</dd>
              </div>
            ))}
          </dl>
          <div data-reveal>
            <ProductShot screen="generate" alt={t('alt')} />
          </div>
        </div>
      </Container>
    </Band>
  );
}

/** "£29" / "£9.50": whole pounds without pence, in the visitor's locale (GBP in every locale). */
function usePounds(): (pence: number) => string {
  const locale = useLocale();
  return (pence) => {
    const whole = pence % 100 === 0;
    return formatNumber(pence / 100, locale, {
      style: 'currency',
      currency: 'GBP',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    });
  };
}

/** The pack sizes and reference amounts (catalogue.ts), smallest first. */
const PACKS = TOP_UP_PACKS.map((pack) => ({
  quantity: pack.quantity,
  pence: REFERENCE_PRICES_PENCE[pack.lookupKey] ?? 0,
}));

export function PricingTeaser() {
  const t = useTranslations('marketing.pricing');
  const tPlan = useTranslations('planPicker');
  const pounds = usePounds();
  const [small, large] = PACKS;
  return (
    <Band labelledBy="pricing-title" className="border-t border-border">
      <Container>
        <div
          data-reveal
          className="grid gap-x-16 gap-y-10 rounded-[1.75rem] bg-surface-raised p-8 ring-1 ring-border md:p-14 lg:grid-cols-[1fr_1.4fr]"
        >
          <div>
            <Eyebrow rec>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="pricing-title">{t('title')}</SectionTitle>
            <p className="mt-6 text-lg text-pretty">{t('body')}</p>
            <ul className="mt-6 grid gap-2 text-muted-foreground">
              {(['billing', 'vat', 'cancel'] as const).map((k) => (
                <li key={k} className="flex items-center gap-2.5">
                  <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                  {t(`points.${k}`)}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid content-start gap-6">
            <ul className="grid gap-3 sm:grid-cols-3" aria-label={t('plansAria')}>
              {PLAN_IDS.map((id) => {
                const popular = id === MOST_POPULAR_PLAN;
                return (
                  <li
                    key={id}
                    data-testid={`landing-plan-${id}`}
                    className={cn(
                      'grid content-start gap-2 rounded-panel bg-background p-5 ring-1',
                      popular ? 'shadow-raised ring-2 ring-foreground/70' : 'ring-border',
                    )}
                  >
                    <p className="flex min-h-6 flex-wrap items-center justify-between gap-2">
                      <span className="font-display text-xl leading-none">{PLAN_NAMES[id]}</span>
                      {popular && (
                        <StatusPill tone="live" dot={false} size="sm">
                          {tPlan('mostPopular')}
                        </StatusPill>
                      )}
                    </p>
                    <p className="font-display text-3xl leading-none tabular-nums">
                      {pounds(planPricePence(id, 'month'))}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('perMonth')}</p>
                    <p className="text-sm">
                      {tPlan('videos.month', { count: STUDIO_PLANS[id].videosPerMonth })}
                    </p>
                  </li>
                );
              })}
            </ul>
            {small && large && (
              <p className="text-muted-foreground">
                {t('packs', {
                  small: small.quantity,
                  smallPrice: pounds(small.pence),
                  large: large.quantity,
                  largePrice: pounds(large.pence),
                })}
              </p>
            )}
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 px-6 text-base sm:justify-self-start"
            >
              <Link href="/pricing">
                {t('cta')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
              </Link>
            </Button>
          </div>
        </div>
      </Container>
    </Band>
  );
}

export function Closing() {
  const t = useTranslations('marketing.closing');
  return (
    <Band labelledBy="closing-title" tone="darkroom">
      <Container className="text-center">
        <div data-reveal className="mx-auto max-w-3xl">
          <Eyebrow rec>{t('eyebrow')}</Eyebrow>
          <h2
            id="closing-title"
            className="mt-5 font-display text-[clamp(2.5rem,1.5rem+4vw,5rem)] leading-[1] text-balance"
          >
            {t('title')}
          </h2>
          <Lede className="mx-auto">{t('body')}</Lede>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link href="/sign-up">
                {t('primaryCta')} <ArrowRight aria-hidden className="rtl:-scale-x-100" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-6 text-base">
              <Link href="/pricing">{t('secondaryCta')}</Link>
            </Button>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">{t('fineprint')}</p>
        </div>
      </Container>
    </Band>
  );
}
