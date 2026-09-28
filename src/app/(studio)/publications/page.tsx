import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PublicationsList } from '@/components/studio/publications/publications-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('publications.list');
  return { title: t('title') };
}

export default function PublicationsPage() {
  return <PublicationsList />;
}
