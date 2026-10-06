import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AutomationsList } from '@/components/studio/automations/automations-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('automations.list');
  return { title: t('title') };
}

export default function AutomationsPage() {
  return <AutomationsList />;
}
