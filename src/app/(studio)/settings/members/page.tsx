import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MembersScreen } from '@/components/studio/settings/members-screen';

// Phase 18 §3 /settings/members (Track E).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('orgSettings.meta');
  return { title: t('membersTitle') };
}

export default function Page() {
  return <MembersScreen />;
}
