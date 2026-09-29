import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProfileScreen } from '@/components/studio/account/profile-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account.profile');
  return { title: t('title') };
}

export default function AccountProfilePage() {
  return <ProfileScreen />;
}
