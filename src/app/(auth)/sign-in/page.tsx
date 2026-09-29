import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SignInForm } from '@/components/auth/sign-in-form';
import { authPageOptions, nextParam, param, type SearchParams } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn');
  return { title: t('title') };
}

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { googleEnabled, signupsEnabled } = authPageOptions();
  return (
    <SignInForm
      next={nextParam(params)}
      googleEnabled={googleEnabled}
      signupsEnabled={signupsEnabled}
      // Google (or another redirect flow) came back with ?error=…: the generic message.
      initialError={param(params, 'error') ? 'redirect_failed' : undefined}
    />
  );
}
