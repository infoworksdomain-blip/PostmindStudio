import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { authPageOptions } from '@/lib/auth/page-options';
import { publicPageMetadata } from '@/lib/seo/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  const [t, seo, meta] = await Promise.all([
    getTranslations('auth.forgot'),
    getTranslations('seo'),
    getTranslations('marketing.meta'),
  ]);
  return publicPageMetadata({
    path: '/forgot-password',
    title: t('title'),
    description: seo('forgotPassword'),
    locale: await getLocale(),
    imageAlt: meta('ogAlt'),
    index: false,
  });
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm supportEmail={authPageOptions().supportEmail} />;
}
