import type { Metadata } from 'next';
import { WelcomeWizard } from '@/components/studio/onboarding/welcome-wizard';

export const metadata: Metadata = { title: 'Welcome' };

export default function WelcomePage() {
  return <WelcomeWizard />;
}
