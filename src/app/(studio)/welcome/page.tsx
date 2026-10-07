import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { WelcomeWizard } from '@/components/studio/onboarding/welcome-wizard';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding.page');
  return { title: t('title') };
}

// The wizard reads ?new=organisation (useSearchParams), which needs a Suspense boundary.
export default function WelcomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WelcomeWizard />
    </Suspense>
  );
}
