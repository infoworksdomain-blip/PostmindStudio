import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BlitzScreen } from '@/components/studio/blitz/blitz-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('blitz.page');
  return { title: t('title') };
}

export default function BlitzPage() {
  return (
    <Suspense>
      <BlitzScreen />
    </Suspense>
  );
}
