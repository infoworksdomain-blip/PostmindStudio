import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PlanMonthForm } from '@/components/studio/plans/plan-month-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('plans.new');
  return { title: t('title') };
}

export default function NewPlanPage() {
  return <PlanMonthForm />;
}
