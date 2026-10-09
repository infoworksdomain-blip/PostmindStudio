import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { LandingPage } from '@/components/marketing/landing-page';
import { APP_HOME } from '@/lib/auth/page-guard';
import { landingDecision } from '@/lib/marketing/session-hint';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

// Phase 18 §3 — `/` is the public landing page. A visitor with a Studio session cookie goes to
// /home (25.4; it was /projects) (the real session check happens there); core mode has no public pages, so `/` opens
// the app as before.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.meta');
  // 25.5 / 26.2: link previews with the image named explicitly (a page-level openGraph replaces the
  // root's file-based image, which left `/` without og:image).
  return publicPageMetadata({
    path: '/',
    title: t('title'),
    description: t('description'),
    locale: await getLocale(),
    imageAlt: t('ogAlt'),
    absoluteTitle: true,
  });
}

export default async function Home() {
  const names = (await cookies()).getAll().map((c) => c.name);
  if (landingDecision(names) === 'app') redirect(APP_HOME);
  return <LandingPage />;
}
