import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyEmailScreen } from '@/components/auth/verify-email-screen';
import { authPageOptions, param, type SearchParams } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verify');
  return { title: t('title') };
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
