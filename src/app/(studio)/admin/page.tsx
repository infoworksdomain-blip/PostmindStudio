import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { AdminCentre } from '@/components/studio/admin/admin-centre';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell.pageTitle');
  return { title: t('admin') };
}

// AdminCentre reads the selected tab from the URL (useSearchParams), which needs a Suspense
// boundary for static rendering.
export default function AdminPage() {
  return (
    <Suspense>
      <AdminCentre />
    </Suspense>
  );
}
