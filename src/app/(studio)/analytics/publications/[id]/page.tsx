import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PublicationAnalytics } from '@/components/studio/analytics/publication-analytics';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('publicationAnalytics') };
}

export default async function PublicationAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PublicationAnalytics publicationId={id} />;
}
