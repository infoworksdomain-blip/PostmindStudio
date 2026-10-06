import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AutomationWizard } from '@/components/studio/automations/automation-wizard';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('automations.wizard');
  return { title: t('title') };
}

export default function NewAutomationPage() {
  return <AutomationWizard />;
}
