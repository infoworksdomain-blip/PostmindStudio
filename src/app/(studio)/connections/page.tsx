import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConnectionsScreen } from '@/components/studio/connections/connections-screen';

export const metadata: Metadata = { title: 'Connections' };

// ConnectionsScreen reads ?connected= / ?connection_error= (useSearchParams), which needs a
// Suspense boundary for static rendering.
export default function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsScreen />
    </Suspense>
  );
}
