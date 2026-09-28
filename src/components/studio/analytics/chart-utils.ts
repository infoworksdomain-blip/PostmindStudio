import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import type { SeriesPoint } from './types';

// Pure geometry for the hand-built SVG charts (no chart library, per the Phase 10 brief).

/** Round a maximum up to a "nice" axis ceiling: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

export interface PlotGeometry {
  max: number;
  /** Points in a 0–100 × 0–100 box (y grows downwards, as in SVG). */
  coords: Array<{ x: number; y: number }>;
  line: string;
  area: string;
}

/** `minMax` keeps an all-zero or tiny series from producing a sub-unit axis (e.g. £0.01). */
export function plot(points: SeriesPoint[], minMax = 1): PlotGeometry {
  const max = Math.max(niceMax(minMax), niceMax(Math.max(0, ...points.map((p) => p.value))));
  const n = points.length;
  const coords = points.map((p, i) => ({
    x: n <= 1 ? 50 : (i / (n - 1)) * 100,
    y: 100 - (Math.max(0, p.value) / max) * 100,
  }));
  const line = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`)
    .join(' ');
  const first = coords[0];
  const last = coords.at(-1);
  const area =
    first && last ? `${line} L${last.x.toFixed(2)},100 L${first.x.toFixed(2)},100 Z` : '';
  return { max, coords, line, area };
}

/** Index of the point nearest a horizontal fraction (0–1) of the plot width. */
export function nearestIndex(fraction: number, count: number): number {
  if (count <= 1) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * (count - 1));
}

/** Day and short month, in UTC (the analytics days are UTC calendar days). */
export const SHORT_DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
};

/**
 * '2026-09-27' → '27 Sep' (en-GB), 'Sep 27' (en-US), '9月27日' (zh-Hans). Components pass the
 * active locale (useShortDay in area-chart.tsx); an unparseable day is returned unchanged.
 */
export function shortDay(day: string, locale: string = DEFAULT_LOCALE): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, SHORT_DAY_OPTIONS).format(date);
}
