import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { LandingPage } from '@/components/marketing/landing-page';
import { APP_HOME } from '@/lib/auth/page-guard';
import { landingDecision } from '@/lib/marketing/session-hint';

// Phase 18 §3 — `/` is the public landing page. A visitor with a Studio session cookie goes to
// /home (25.4; it was /projects) (the real session check happens there); core mode has no public pages, so `/` opens
// the app as before.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.meta');
  const title = t('title');
  const description = t('description');
  // 25.5: link previews. The image is src/app/opengraph-image.tsx (Next adds it to both cards).
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      url: '/',
      siteName: 'PostMind Studio',
      locale: (await getLocale()).replace('-', '_'),
      title,
      description,
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function Home() {
  const names = (await cookies()).getAll().map((c) => c.name);
  if (landingDecision(names) === 'app') redirect(APP_HOME);
  return <LandingPage />;
}
