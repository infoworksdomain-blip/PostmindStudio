import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/studio/page-skeleton';
import { ConnectionsScreen } from '@/components/studio/connections/connections-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('settingsNav.items');
  return { title: t('connections') };
}

// ConnectionsScreen reads ?connected= / ?connection_error= (useSearchParams), which needs a
// Suspense boundary for static rendering.
export default function ConnectionsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ConnectionsScreen />
    </Suspense>
  );
}
