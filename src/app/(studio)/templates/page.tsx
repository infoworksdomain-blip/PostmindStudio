import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TemplatesScreen } from '@/components/studio/templates/templates-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('templates');
  return { title: t('title') };
}

export default function TemplatesPage() {
  return <TemplatesScreen />;
}
