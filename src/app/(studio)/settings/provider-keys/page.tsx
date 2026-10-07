import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ProviderKeysScreen } from '@/components/studio/settings/provider-keys-screen';

// 25.12: bring-your-own AI provider keys, moved here from the bottom of Connections.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settingsNav.items');
  return { title: t('providerKeys') };
}

export default function ProviderKeysPage() {
  return <ProviderKeysScreen />;
}
