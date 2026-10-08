'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ErrorState } from '../primitives';
import { AreaChart } from './area-chart';
import type { SeriesState } from './use-series';

// BACKLOG 25.11 — a daily series in one of its states: loading (a skeleton the size of the chart
// and its axis band, so nothing shifts), failed (error with Retry), all quiet (a sentence instead of
// a flat line), or the chart. While a new window loads, the previous chart stays, dimmed.

export const CHART_HEIGHT = 200;
/** The x-axis label band under the plot (mt-2 + one line of 0.6875rem text). */
const AXIS_BAND = 26;

export function ChartSkeleton({
  height = CHART_HEIGHT,
  label,
}: {
  height?: number;
  label: string;
}) {
  return (
    <Skeleton
      role="status"
      aria-label={label}
      className="rounded-field"
      style={{ height: height + AXIS_BAND }}
    />
  );
}

export function SeriesChart({
  series,
  label,
  formatValue,
  color,
  quiet,
  height = CHART_HEIGHT,
}: {
  series: SeriesState;
  label: string;
  formatValue: (value: number) => string;
  color?: string;
  /** Said instead of an all-zero chart. */
  quiet: string;
  height?: number;
}) {
  const t = useTranslations('analytics.trend');
  if (series.error) return <ErrorState error={series.error} onRetry={series.retry} />;
  if (series.isLoading) return <ChartSkeleton height={height} label={t('loadingAria')} />;
  const allZero = series.points.every((p) => p.value === 0);
  return (
    <div
      aria-busy={series.isRefreshing || undefined}
      className={cn(
        'transition-opacity duration-(--duration-base) ease-standard motion-reduce:transition-none',
        series.isRefreshing && 'opacity-60',
      )}
    >
      {series.hasEstimates && (
        <p role="note" className="mb-3 text-xs text-muted-foreground">
          {t('estimated')}
        </p>
      )}
      {allZero ? (
        <div
          className="grid place-items-center rounded-field border border-dashed border-border px-6 text-center text-sm text-muted-foreground"
          style={{ height: height + AXIS_BAND }}
        >
          <p className="max-w-sm text-pretty">{quiet}</p>
        </div>
      ) : (
        <AreaChart
          points={series.points}
          label={label}
          formatValue={formatValue}
          color={color}
          height={height}
        />
      )}
    </div>
  );
}
