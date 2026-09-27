'use client';

import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatCount, formatDuration } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { AreaChart } from './area-chart';
import { shortDay } from './chart-utils';
import { Segmented } from './segmented';
import { METRIC_LABEL, type Metric, type TimeseriesResponse } from './types';

// Daily activity (GET /analytics/timeseries?days&metric) — the difference between each
// publication's consecutive daily snapshots, summed across the organisation.

const TREND_METRICS: Metric[] = ['views', 'watchTime', 'engagement'];

export function formatMetric(metric: Metric, value: number): string {
  return metric === 'watchTime' ? formatDuration(value) : formatCount(value);
}

export function TrendSection({ days }: { days: number }) {
  const [metric, setMetric] = useState<Metric>('views');
  const { data, error, isLoading, mutate } = useApi<TimeseriesResponse>('/analytics/timeseries', {
    days,
    metric,
  });
  const points = (data?.data ?? []).map((d) => ({ label: shortDay(d.day), value: d.value }));
  const total = points.reduce((t, p) => t + p.value, 0);

  return (
    <Section
      title="Daily activity"
      description={
        data
          ? `${formatMetric(metric, total)} ${METRIC_LABEL[metric].toLowerCase()} in the window`
          : ' '
      }
      actions={
        <Segmented
          label="Metric"
          value={metric}
          onChange={setMetric}
          options={TREND_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
        />
      }
    >
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading chart" className="h-[200px] rounded-lg" />}
      {data && (
        <AreaChart
          points={points}
          label={`${METRIC_LABEL[metric]} per day, last ${days} days`}
          formatValue={(v) => formatMetric(metric, v)}
        />
      )}
    </Section>
  );
}
