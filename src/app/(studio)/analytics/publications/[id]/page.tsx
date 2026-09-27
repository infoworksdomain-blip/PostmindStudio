import type { Metadata } from 'next';
import { PublicationAnalytics } from '@/components/studio/analytics/publication-analytics';

export const metadata: Metadata = { title: 'Publication analytics' };

export default async function PublicationAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PublicationAnalytics publicationId={id} />;
}
