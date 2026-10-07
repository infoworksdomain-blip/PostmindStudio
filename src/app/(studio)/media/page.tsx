import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { MediaScreen } from '@/components/studio/media/media-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('media.page');
  return { title: t('title') };
}

// BACKLOG 25.10 — My media: the business's finished videos, uploads and images in one place.
// The chosen segment lives in the URL (?type=), which needs a Suspense boundary.
export default function MediaPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <MediaScreen />
    </Suspense>
  );
}
