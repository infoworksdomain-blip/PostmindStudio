import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AutomationDetailScreen } from '@/components/studio/automations/automation-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('automations.list');
  return { title: t('title') };
}

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationDetailScreen automationId={id} />;
}
