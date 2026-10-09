import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { NotFoundView } from '@/components/errors/page-error';
import { MarketingHeader } from '@/components/marketing/marketing-shell';
import { APP_HOME } from '@/lib/auth/page-guard';
import { landingDecision } from '@/lib/marketing/session-hint';

// 20.10 — every unknown URL (and every notFound() call) renders this, translated, instead of
// Next's English-only default. 25.6: a signed-in visitor (the session cookie's name, as the landing
// page checks it; never verified here) is offered Home, anyone else the home page and sign-in.
// 26.2: under the site header (the mark links home), so the page is not an orphan; signed in, the
// header shows only the mark (no Sign in or trial button).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('errorPage.notFound');
  return { title: t('title') };
}

export default async function NotFound() {
  const names = (await cookies()).getAll().map((c) => c.name);
  const signedIn = landingDecision(names) === 'app';
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <MarketingHeader home={signedIn ? APP_HOME : '/'} nav={!signedIn} />
      <main className="flex flex-1 items-center px-4 sm:px-8">
        <NotFoundView signedIn={signedIn} />
      </main>
    </div>
  );
}
