import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { WelcomeWizard } from '@/components/studio/onboarding/welcome-wizard';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('onboarding.page');
  return { title: t('title') };
}

export default function WelcomePage() {
  return <WelcomeWizard />;
}
