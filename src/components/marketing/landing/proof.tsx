import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/client/format';
import { QUARTERS_PER_VIDEO, QUICK_POST_QUARTERS } from '@/lib/studio/billing/allowance-units';
import {
  MONTHLY_PRICE_PER_CHANNEL_PENCE,
  VIDEOS_PER_CHANNEL_PER_PERIOD,
} from '@/lib/studio/billing/channel-plan';
import { Band, Container, Eyebrow, Lede, ProductShot, SectionTitle } from './primitives';

// 25.5 §7–§10 — analytics (the real screen), brand kit and approvals (the image library screen),
// the pricing teaser and the closing call to action. The teaser's numbers come from the channel
// plan (channel-plan.ts: £29 per channel a month, 8 HD videos, quick posts count ¼); live amounts
// are on /pricing, read from Stripe.

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

const VIDEOS = VIDEOS_PER_CHANNEL_PER_PERIOD.month;
/** Quick posts count ¼ of a video: 8 videos → up to 32 quick posts. */
const QUICK_POSTS = (VIDEOS * QUARTERS_PER_VIDEO) / QUICK_POST_QUARTERS;

/** "£29": whole pounds without pence, in the visitor's locale (GBP in every locale). */
function usePlanPrice(): string {
  const locale = useLocale();
  const whole = MONTHLY_PRICE_PER_CHANNEL_PENCE % 100 === 0;
  return formatNumber(MONTHLY_PRICE_PER_CHANNEL_PENCE / 100, locale, {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

export function PricingTeaser() {
  const t = useTranslations('marketing.pricing');
  const price = usePlanPrice();
  return (
    <Band labelledBy="pricing-title" className="border-t border-border">
      <Container>
        <div
          data-reveal
          className="grid gap-x-16 gap-y-10 rounded-[1.75rem] bg-surface-raised p-8 ring-1 ring-border md:p-14 lg:grid-cols-[1fr_1.2fr]"
        >
          <div>
            <Eyebrow rec>{t('eyebrow')}</Eyebrow>
            <SectionTitle id="pricing-title">{t('title')}</SectionTitle>
            <p className="mt-8 flex flex-wrap items-baseline gap-x-3">
              <span className="font-display text-[clamp(4rem,2.5rem+5vw,7rem)] leading-none tabular-nums">
                {price}
              </span>
              <span className="text-lg text-muted-foreground">{t('per')}</span>
            </p>
          </div>
          <div className="lg:pt-10">
            <p className="text-lg text-pretty">
              {t('body', { videos: VIDEOS, quick: QUICK_POSTS })}
            </p>
            <ul className="mt-6 grid gap-2 text-muted-foreground">
              {(['billing', 'vat', 'cancel'] as const).map((k) => (
                <li key={k} className="flex items-center gap-2.5">
                  <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                  {t(`points.${k}`)}
                </li>
              ))}
            </ul>
            <Button asChild size="lg" variant="outline" className="mt-8 h-12 px-6 text-base">
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
