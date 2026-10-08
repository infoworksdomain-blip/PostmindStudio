import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { LibraryBrowse } from '@/components/studio/library/library-browse';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('library') };
}

// 25.10: the library keeps its filters in the URL (useSearchParams), which needs a Suspense
// boundary.
export default function LibraryPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <LibraryBrowse />
    </Suspense>
  );
}
