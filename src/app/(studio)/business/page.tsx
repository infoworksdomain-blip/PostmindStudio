import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BusinessScreen } from '@/components/studio/business/business-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('business.screen');
  return { title: t('title') };
}

export default function BusinessPage() {
  return <BusinessScreen />;
}
