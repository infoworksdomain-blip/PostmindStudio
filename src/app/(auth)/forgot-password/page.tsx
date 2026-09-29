import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { authPageOptions } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgot');
  return { title: t('title') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm supportEmail={authPageOptions().supportEmail} />;
}
