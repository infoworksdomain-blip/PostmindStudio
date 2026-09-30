import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PlansList } from '@/components/studio/plans/plans-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('plans.list');
  return { title: t('title') };
}

export default function PlansPage() {
  return <PlansList />;
}
