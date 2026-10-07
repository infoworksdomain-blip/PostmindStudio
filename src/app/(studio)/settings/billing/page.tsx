import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { BillingScreen } from '@/components/studio/billing/billing-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('billing');
  return { title: t('meta.title') };
}

// BillingScreen reads ?checkout= / ?topup= (useSearchParams), which needs a Suspense boundary.
export default function BillingSettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BillingScreen />
    </Suspense>
  );
}
