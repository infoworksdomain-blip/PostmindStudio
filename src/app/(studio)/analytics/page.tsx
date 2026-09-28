import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AnalyticsDashboard } from '@/components/studio/analytics/analytics-dashboard';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('analytics') };
}

export default function AnalyticsPage() {
  return <AnalyticsDashboard />;
}
