import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NotFoundView } from '@/components/errors/page-error';

// 20.10 — every unknown URL (and every notFound() call) renders this, translated, instead of
// Next's English-only default.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('errorPage.notFound');
  return { title: t('title') };
}

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-4">
      <NotFoundView />
    </main>
  );
}
