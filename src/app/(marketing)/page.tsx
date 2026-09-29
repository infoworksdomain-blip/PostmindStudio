import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LandingPage } from '@/components/marketing/landing-page';
import { landingDecision } from '@/lib/marketing/session-hint';

// Phase 18 §3 — `/` is the public landing page. A visitor with a Studio session cookie goes to
// /projects (the real session check happens there); core mode has no public pages, so `/` opens
// the app as before.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing.meta');
  return { title: { absolute: t('title') }, description: t('description') };
}

export default async function Home() {
  const names = (await cookies()).getAll().map((c) => c.name);
  if (landingDecision(names) === 'app') redirect('/projects');
  return <LandingPage />;
}
