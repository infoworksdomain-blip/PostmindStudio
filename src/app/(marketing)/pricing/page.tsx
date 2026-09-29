import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PricingScreen } from '@/components/studio/billing/pricing-screen';
import { logger } from '@/lib/logger';
import { pricingSourceFromEnv } from '@/lib/studio/billing/wiring';

// Phase 18 §3 / §P.4 — public /pricing. Prices come from Stripe by lookup key (10-minute cache in
// the pricing source), so a price change in Stripe shows here with no deploy; without Stripe the
// page still renders the catalogue with "price unavailable".
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('pricing');
  return { title: t('meta.title') };
}

export default async function PricingPage() {
  const pricing = await pricingSourceFromEnv(logger).get();
  const salesEmail = process.env.STUDIO_SALES_EMAIL?.trim() || null;
  return <PricingScreen pricing={pricing} salesEmail={salesEmail} />;
}
