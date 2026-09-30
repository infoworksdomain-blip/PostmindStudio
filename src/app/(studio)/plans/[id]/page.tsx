import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PlanScreen } from '@/components/studio/plans/plan-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('plans.new');
  return { title: t('title') };
}

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanScreen planId={id} />;
}
