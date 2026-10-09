import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { SignInForm } from '@/components/auth/sign-in-form';
import { authPageOptions, nextParam, param, type SearchParams } from '@/lib/auth/page-options';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const [t, seo, meta] = await Promise.all([
    getTranslations('auth.signIn'),
    getTranslations('seo'),
    getTranslations('marketing.meta'),
  ]);
  return publicPageMetadata({
    path: '/sign-in',
    title: t('title'),
    description: seo('signIn'),
    locale: await getLocale(),
    imageAlt: meta('ogAlt'),
  });
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
