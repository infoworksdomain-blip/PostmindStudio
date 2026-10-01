'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { useProjectName } from '@/lib/client/use-project-name';
import { ErrorState, Section } from '../primitives';
import { AreaChart, useShortDay } from './area-chart';
import { BarList } from './bar-list';
import type { CostResponse } from './types';

// Spend (GET /analytics/cost?days) — provider-job ledger by day, provider and project.

/** Fill the days the ledger has no rows for, so the chart shows quiet days as zero. */
export function fillDays(
  byDay: CostResponse['byDay'],
  days: number,
  now: number = Date.now(),
): Array<{ day: string; costPence: number }> {
  const known = new Map(byDay.map((d) => [d.day, d.costPence]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, costPence: known.get(day) ?? 0 });
  }
  return out;
}

export function CostSection({
  days,
  data,
  error,
  isLoading,
  retry,
}: {
  days: number;
  data?: CostResponse;
  error?: unknown;
  isLoading: boolean;
  retry: () => void;
}) {
  const t = useTranslations('analytics.cost');
  const f = useFormat();
  const shortDay = useShortDay();
  const projectName = useProjectName();
  if (error)
    return (
      <Section title={t('title')}>
        <ErrorState error={error} onRetry={retry} />
      </Section>
    );
  if (isLoading || !data)
    return (
      <Section title={t('title')}>
        <Skeleton className="h-48 rounded-lg" />
      </Section>
    );

  const points = fillDays(data.byDay, days).map((d) => ({
    label: shortDay(d.day),
    value: d.costPence,
  }));
  return (
    <Section
      title={t('title')}
      description={t('description', { total: f.pence(data.totalPence), days })}
    >
      <AreaChart
        points={points}
        label={t('chartLabel', { days })}
        formatValue={f.pence}
        minMax={100}
        color="var(--chart-2)"
        height={140}
      />
      <div className="mt-8 grid gap-8 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">
            {t('byProvider.title')}
          </h3>
          <BarList
            label={t('byProvider.listLabel')}
            empty={t('byProvider.empty')}
            tone="var(--chart-2)"
            rows={data.byProvider.map((p) => ({
              key: p.provider,
              label: p.provider,
              value: p.costPence,
              display: f.pence(p.costPence),
              hint: t('byProvider.jobs', { count: p.jobs }),
            }))}
          />
        </div>
        <div>
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">{t('byProject.title')}</h3>
          <BarList
            label={t('byProject.listLabel')}
            empty={t('byProject.empty')}
            tone="var(--chart-1)"
            rows={data.byProject.slice(0, 8).map((p) => ({
              key: p.projectId ?? 'none',
              label: p.projectId ? (
                <Link href={`/projects/${p.projectId}`} className="text-sm hover:underline">
                  {projectName(p.name)}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t('byProject.none')}</span>
              ),
              value: p.costPence,
              display: f.pence(p.costPence),
            }))}
          />
        </div>
      </div>
    </Section>
  );
}
