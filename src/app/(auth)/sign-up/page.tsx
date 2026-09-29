import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SignUpClosed } from '@/components/auth/sign-up-closed';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { authPageOptions, nextParam, type SearchParams } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signUp');
  return { title: t('title') };
}

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { googleEnabled, signupsEnabled } = authPageOptions();
  if (!signupsEnabled) return <SignUpClosed />;
  return <SignUpForm next={nextParam(params, '/welcome')} googleEnabled={googleEnabled} />;
}
