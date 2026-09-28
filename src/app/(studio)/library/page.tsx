import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LibraryBrowse } from '@/components/studio/library/library-browse';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('library') };
}

export default function LibraryPage() {
  return <LibraryBrowse />;
}
