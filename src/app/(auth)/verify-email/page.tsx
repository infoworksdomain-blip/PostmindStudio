import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyEmailScreen } from '@/components/auth/verify-email-screen';
import { authPageOptions, param, type SearchParams } from '@/lib/auth/page-options';
import { NOINDEX } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verify');
  // 26.2: one-time links and mid-sign-in steps never belong in search results.
  return { title: t('title'), robots: NOINDEX };
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return (
    <VerifyEmailScreen
      email={param(params, 'email')}
      error={param(params, 'error')}
      supportEmail={authPageOptions().supportEmail}
    />
  );
}
