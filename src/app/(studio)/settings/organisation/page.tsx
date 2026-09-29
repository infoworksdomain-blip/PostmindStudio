import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OrganisationSettingsScreen } from '@/components/studio/settings/organisation-settings';

// Phase 18 §3 /settings/organisation (Track E).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('orgSettings.meta');
  return { title: t('organisationTitle') };
}

export default function Page() {
  return <OrganisationSettingsScreen />;
}
