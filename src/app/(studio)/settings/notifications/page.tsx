import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NotificationPreferencesScreen } from '@/components/studio/notification-preferences';

// 25.12: notification preferences as a Settings page (the bell's dialog shows the same table).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settingsNav.items');
  return { title: t('notifications') };
}

export default function NotificationSettingsPage() {
  return <NotificationPreferencesScreen />;
}
