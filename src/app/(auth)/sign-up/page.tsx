import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { SignUpClosed } from '@/components/auth/sign-up-closed';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { authPageOptions, nextParam, type SearchParams } from '@/lib/auth/page-options';
import { signupsOpen } from '@/lib/legal/readiness';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const [t, seo, meta] = await Promise.all([
    getTranslations('auth.signUp'),
    getTranslations('seo'),
    getTranslations('marketing.meta'),
  ]);
  return publicPageMetadata({
    path: '/sign-up',
    title: t('title'),
    description: seo('signUp'),
    locale: await getLocale(),
    imageAlt: meta('ogAlt'),
  });
}

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const { googleEnabled, signupsEnabled } = authPageOptions();
  // Phase 18 Track E legal gate: production sign-up stays closed while terms/privacy are placeholders.
  if (!signupsEnabled || !(await signupsOpen()).open) return <SignUpClosed />;
  return <SignUpForm next={nextParam(params, '/welcome')} googleEnabled={googleEnabled} />;
}
