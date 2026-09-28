'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { AreaChart, useShortDay } from './area-chart';
import { Segmented } from './segmented';
import type { Metric, TimeseriesResponse } from './types';

// Daily activity (GET /analytics/timeseries?days&metric) — the difference between each
// publication's consecutive daily snapshots, summed across the organisation.

const TREND_METRICS = ['views', 'watchTime', 'engagement'] as const satisfies readonly Metric[];
type TrendMetric = (typeof TREND_METRICS)[number];

export function formatMetric(f: StudioFormat, metric: Metric, value: number): string {
  return metric === 'watchTime' ? f.duration(value) : f.count(value);
}

export function TrendSection({ days }: { days: number }) {
  const t = useTranslations('analytics.trend');
  const tm = useTranslations('analytics.metrics');
  const f = useFormat();
  const shortDay = useShortDay();
  const [metric, setMetric] = useState<TrendMetric>('views');
  const { data, error, isLoading, mutate } = useApi<TimeseriesResponse>('/analytics/timeseries', {
    days,
    metric,
  });
  const points = (data?.data ?? []).map((d) => ({ label: shortDay(d.day), value: d.value }));
  const total = points.reduce((t, p) => t + p.value, 0);

  return (
    <Section
      title={t('title')}
      description={
        data ? t(`total.${metric}`, { value: formatMetric(f, metric, total), count: total }) : ' '
      }
      actions={
        <Segmented
          label={t('metricLabel')}
          value={metric}
          onChange={setMetric}
          options={TREND_METRICS.map((m) => ({ value: m, label: tm(m) }))}
        />
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loadingAria')} className="h-[200px] rounded-lg" />}
      {data && (
        <AreaChart
          points={points}
          label={t(`chartLabel.${metric}`, { days })}
          formatValue={(v) => formatMetric(f, metric, v)}
        />
      )}
    </Section>
  );
}
