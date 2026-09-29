import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuditScreen } from '@/components/studio/settings/audit-screen';

// Phase 18 §3 /settings/audit (Track E).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('orgSettings.meta');
  return { title: t('auditTitle') };
}

export default function Page() {
  return <AuditScreen />;
}
