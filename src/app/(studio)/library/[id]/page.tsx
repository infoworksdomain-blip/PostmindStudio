import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LibraryDetail } from '@/components/studio/library/library-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('libraryVideo') };
}

export default async function LibraryVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LibraryDetail id={id} />;
}
