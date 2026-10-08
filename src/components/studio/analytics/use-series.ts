'use client';

import { useApi } from '@/lib/client/api';
import { useShortDay } from './area-chart';
import { currentWindow, periodChange, type PeriodChange } from './analytics-model';
import type { Metric, SeriesPoint, TimeseriesResponse } from './types';

// BACKLOG 25.11 — one daily series for a section. It asks for twice the window so the section can
// compare this period with the one before it (both from the same endpoint and the same snapshots);
// only the current window is plotted. The previous render stays on screen while a new window or
// business loads (keepPreviousData), so switching never flashes a skeleton or shifts the layout.

export interface SeriesState {
  points: SeriesPoint[];
  change: PeriodChange | null;
  hasEstimates: boolean;
  error: unknown;
  isLoading: boolean;
  /** True while a newer window is loading over the previous one. */
  isRefreshing: boolean;
  retry: () => void;
}

export function useSeries(
  metric: Metric,
  days: number,
  businessId: string | null,
  enabled = true,
): SeriesState {
  const shortDay = useShortDay();
  const { data, error, isLoading, isValidating, mutate } = useApi<TimeseriesResponse>(
    enabled ? '/analytics/timeseries' : null,
    { days: days * 2, metric, ...(businessId && { businessId }) },
    { keepPreviousData: true },
  );
  const series = data?.data ?? [];
  const window = currentWindow(series, days);
  return {
    points: window.map((d) => ({ label: shortDay(d.day), value: d.value })),
    change: data ? periodChange(series, days) : null,
    hasEstimates: window.some((d) => d.estimated),
    error,
    isLoading: isLoading && !data,
    isRefreshing: Boolean(data) && isValidating,
    retry: () => void mutate(),
  };
}
