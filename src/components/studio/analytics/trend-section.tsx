'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useFormat, type StudioFormat } from '@/lib/client/format';
import { Section } from '../primitives';
import { ChangeBadge } from './change-badge';
import { SeriesChart } from './series-chart';
import type { Metric } from './types';
import { useSeries } from './use-series';

// BACKLOG 25.11 — growth and reach: views (or watch time) gained per day across the selected
// business's posts (GET /analytics/timeseries — the difference between each publication's
// consecutive daily snapshots), with the change against the previous period of the same length.

const TREND_METRICS = ['views', 'watchTime'] as const satisfies readonly Metric[];
type TrendMetric = (typeof TREND_METRICS)[number];

export function formatMetric(f: StudioFormat, metric: Metric, value: number): string {
  return metric === 'watchTime' ? f.duration(value) : f.count(value);
}

export function TrendSection({ days, businessId }: { days: number; businessId: string | null }) {
  const t = useTranslations('analytics.trend');
  const tm = useTranslations('analytics.metrics');
  const f = useFormat();
  const [metric, setMetric] = useState<TrendMetric>('views');
  const series = useSeries(metric, days, businessId);
  const total = series.change?.current ?? 0;

  return (
    <Section
      title={t('title')}
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {series.change
              ? t(`total.${metric}`, {
                  value: formatMetric(f, metric, total),
                  count: total,
                  days,
                })
              : t('description')}
          </span>
          <ChangeBadge change={series.change} days={days} />
        </span>
      }
      actions={
        <SegmentedControl
          size="sm"
          label={t('metricLabel')}
          value={metric}
          onChange={setMetric}
          options={TREND_METRICS.map((m) => ({ value: m, label: tm(m) }))}
        />
      }
    >
      <SeriesChart
        series={series}
        label={t(`chartLabel.${metric}`, { days })}
        formatValue={(v) => formatMetric(f, metric, v)}
        quiet={t('quiet', { days })}
      />
    </Section>
  );
}
