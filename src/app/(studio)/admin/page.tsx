import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AdminCentre } from '@/components/studio/admin/admin-centre';

export const metadata: Metadata = { title: 'Admin Centre' };

// AdminCentre reads the selected tab from the URL (useSearchParams), which needs a Suspense
// boundary for static rendering.
export default function AdminPage() {
  return (
    <Suspense>
      <AdminCentre />
    </Suspense>
  );
}
