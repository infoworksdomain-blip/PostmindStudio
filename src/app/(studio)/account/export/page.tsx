import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ExportScreen } from '@/components/studio/account/export-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.export');
  return { title: t('title') };
}

export default function AccountExportPage() {
  return <ExportScreen />;
}
