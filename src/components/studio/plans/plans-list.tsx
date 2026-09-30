'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { useBusiness } from '../business-context';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { PlanStatusBadge } from './plan-parts';
import { planRange } from './plan-screen';
import type { PlanSummary } from './plan-model';

// 20.9 — /plans: the active business's month plans, newest first, each linking to its page.

export function PlansList() {
  const t = useTranslations('plans.list');
  const f = useFormat();
  const { businessId } = useBusiness();
  const { data, error, mutate } = useApi<{ data: PlanSummary[] }>('/content-plans', {
    businessId,
  });
  const newPlan = (
    <Button asChild>
      <Link href="/plans/new">
        <CalendarRange /> {t('new')}
      </Link>
    </Button>
  );
  const day = (iso: string) => f.date(iso, { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} actions={newPlan} />
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {!data && !error && <Skeleton aria-label={t('loading')} className="h-40 rounded-xl" />}
      {data && data.data.length === 0 && (
        <EmptyState title={t('empty')} description={t('emptyBody')} action={newPlan} />
      )}
      {data && data.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.data.map((plan) => {
            const range = planRange(plan);
            const posts =
              Object.values(plan.counts).reduce((a, b) => a + b, 0) -
              plan.counts.REMOVED -
              plan.counts.SKIPPED;
            return (
              <li key={plan.id}>
                <Link
                  href={`/plans/${plan.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {t('range', { start: day(range.start), end: day(range.end) })}
                  </span>
                  <span className="flex items-center gap-3 text-sm text-muted-foreground">
                    {t('posts', { count: posts })}
                    <PlanStatusBadge status={plan.status} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
