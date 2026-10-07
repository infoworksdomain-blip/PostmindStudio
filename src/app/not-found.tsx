import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { NotFoundView } from '@/components/errors/page-error';
import { landingDecision } from '@/lib/marketing/session-hint';

// 20.10 — every unknown URL (and every notFound() call) renders this, translated, instead of
// Next's English-only default. 25.6: a signed-in visitor (the session cookie's name, as the landing
// page checks it; never verified here) is offered Home, anyone else the home page and sign-in.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('errorPage.notFound');
  return { title: t('title') };
}

export default async function NotFound() {
  const names = (await cookies()).getAll().map((c) => c.name);
  return (
    <main className="flex min-h-dvh items-center bg-background px-4 sm:px-8">
      <NotFoundView signedIn={landingDecision(names) === 'app'} />
    </main>
  );
}
