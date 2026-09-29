import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SecurityScreen } from '@/components/studio/account/security/security-screen';
import { authPageOptions } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('security');
  return { title: t('title') };
}

export default function AccountSecurityPage() {
  return <SecurityScreen googleEnabled={authPageOptions().googleEnabled} />;
}
