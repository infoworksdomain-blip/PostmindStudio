import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { param, type SearchParams } from '@/lib/auth/page-options';
import { NOINDEX } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.reset');
  // 26.2: one-time links and mid-sign-in steps never belong in search results.
  return { title: t('title'), robots: NOINDEX };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  return <ResetPasswordForm token={param(params, 'token')} error={param(params, 'error')} />;
}
