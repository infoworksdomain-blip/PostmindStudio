import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { ReviewScreen } from '@/components/studio/review/review-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('review.page');
  return { title: t('title') };
}

// 25.8: ReviewScreen keeps its tab in the URL (useSearchParams), which needs a Suspense boundary.
export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReviewScreen projectId={id} />
    </Suspense>
  );
}
