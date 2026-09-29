import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TwoFactorForm } from '@/components/auth/two-factor-form';
import { nextParam, type SearchParams } from '@/lib/auth/page-options';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.twoFactor');
  return { title: t('title') };
}

export default async function TwoFactorPage({ searchParams }: { searchParams: SearchParams }) {
  return <TwoFactorForm next={nextParam(await searchParams)} />;
}
