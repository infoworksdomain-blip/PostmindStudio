import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AnalyticsDashboard } from '@/components/studio/analytics/analytics-dashboard';
import { PageSkeleton } from '@/components/studio/page-skeleton';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('analytics') };
}

// 25.11: the dashboard keeps its period in the URL (useSearchParams), which needs a Suspense boundary.
export default function AnalyticsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AnalyticsDashboard />
    </Suspense>
  );
}
