import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TwoFactorForm } from '@/components/auth/two-factor-form';
import { nextParam, type SearchParams } from '@/lib/auth/page-options';
import { NOINDEX } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.twoFactor');
  // 26.2: one-time links and mid-sign-in steps never belong in search results.
  return { title: t('title'), robots: NOINDEX };
}

export default async function TwoFactorPage({ searchParams }: { searchParams: SearchParams }) {
  return <TwoFactorForm next={nextParam(await searchParams)} />;
}
