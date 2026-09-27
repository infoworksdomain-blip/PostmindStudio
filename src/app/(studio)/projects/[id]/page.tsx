import type { Metadata } from 'next';
import { ReviewScreen } from '@/components/studio/review/review-screen';

export const metadata: Metadata = { title: 'Review' };

export default async function ProjectReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReviewScreen projectId={id} />;
}
