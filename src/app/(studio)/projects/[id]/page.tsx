import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReviewScreen } from '@/components/studio/review/review-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('review.page');
  return { title: t('title') };
}

export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewScreen projectId={id} />;
}
