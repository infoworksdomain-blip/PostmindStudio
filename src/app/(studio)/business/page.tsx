import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { BusinessScreen } from '@/components/studio/business/business-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('business.screen');
  return { title: t('title') };
}

// 20.13: BusinessScreen reads ?tab= (useSearchParams), which needs a Suspense boundary.
export default function BusinessPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BusinessScreen />
    </Suspense>
  );
}
