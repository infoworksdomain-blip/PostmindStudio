import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { PricingScreen } from '@/components/studio/billing/pricing-screen';
import { logger } from '@/lib/logger';
import { pricingSourceFromEnv } from '@/lib/studio/billing/wiring';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

// Phase 18 §3 / §P.4 — public /pricing. Prices come from Stripe by lookup key (10-minute cache in
// the pricing source), so a price change in Stripe shows here with no deploy; without Stripe the
// page still renders the catalogue with "price unavailable".
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const [t, seo, meta] = await Promise.all([
    getTranslations('pricing'),
    getTranslations('seo'),
    getTranslations('marketing.meta'),
  ]);
  return publicPageMetadata({
    path: '/pricing',
    title: t('meta.title'),
    description: seo('pricing'),
    locale: await getLocale(),
    imageAlt: meta('ogAlt'),
  });
}

export default async function PricingPage() {
  const pricing = await pricingSourceFromEnv(logger).get();
  return <PricingScreen pricing={pricing} />;
}
