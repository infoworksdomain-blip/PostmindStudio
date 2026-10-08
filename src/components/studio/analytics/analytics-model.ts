import type { StudioFormat } from '@/lib/client/format';
import type { BestSlot, BestTimesResponse, OverviewResponse } from './types';

// BACKLOG 25.11 — pure helpers behind the analytics page: headline ratios, the change against the
// previous period (computed from the doubled timeseries the trend already fetches, never invented),
// the platform that led, the engagement mix and the best posting slots.

type Totals = OverviewResponse['totals'];

export function engagementTotal(t: Totals): number {
  return t.likes + t.comments + t.shares + t.saves;
}

/** Engagement as a fraction of views (0.032 = 3.2 %); null when nothing was viewed. */
export function engagementRate(t: Totals): number | null {
  if (t.views <= 0) return null;
  return engagementTotal(t) / t.views;
}

export interface PeriodChange {
  current: number;
  previous: number;
  /** (current − previous) / previous; null when there is no previous activity to compare with. */
  change: number | null;
}

/**
 * Sum the last `days` points (this period) and the `days` before them (the previous period) of a
 * daily series fetched for 2 × days. Null when the series does not reach back a whole previous
 * period, so a partial window is never passed off as a comparison.
 */
export function periodChange(series: ReadonlyArray<{ value: number }>, days: number): PeriodChange {
  const sum = (rows: ReadonlyArray<{ value: number }>) => rows.reduce((t, r) => t + r.value, 0);
  const current = sum(series.slice(-days));
  if (series.length < days * 2) return { current, previous: 0, change: null };
  const previous = sum(series.slice(-days * 2, -days));
  return { current, previous, change: previous > 0 ? (current - previous) / previous : null };
}

/** The last `days` points of a series (what the chart plots). */
export function currentWindow<T>(series: readonly T[], days: number): T[] {
  return series.slice(-days);
}

/** Direction of a change, for the arrow and the wording (a flat change is under ½ %). */
export function changeDirection(change: number): 'up' | 'down' | 'flat' {
  if (Math.abs(change) < 0.005) return 'flat';
  return change > 0 ? 'up' : 'down';
}

export interface PlatformLead {
  platform: string;
  views: number;
  /** Share of all views, 0–1. */
  share: number;
}

/** The platform with the most views, when there were views and more than one platform. */
export function leadingPlatform(byPlatform: OverviewResponse['byPlatform']): PlatformLead | null {
  const rows = Object.entries(byPlatform);
  const total = rows.reduce((t, [, v]) => t + v.views, 0);
  if (rows.length < 2 || total <= 0) return null;
  const [platform, top] = rows.reduce((best, row) => (row[1].views > best[1].views ? row : best));
  return { platform, views: top.views, share: top.views / total };
}

export const ENGAGEMENT_PARTS = ['likes', 'comments', 'shares', 'saves'] as const;
export type EngagementPart = (typeof ENGAGEMENT_PARTS)[number];

/** Likes, comments, shares and saves, largest first (ties keep that order). */
export function engagementMix(t: Totals): Array<{ key: EngagementPart; value: number }> {
  return ENGAGEMENT_PARTS.map((key) => ({ key, value: t[key] })).sort((a, b) => b.value - a.value);
}

/**
 * The slots to show, best first: the ranked slots when there is enough history, otherwise the
 * per-day suggestions (which may come from the business's learned posting time).
 */
export function rankedSlots(best: BestTimesResponse | undefined, limit = 5): BestSlot[] {
  if (!best) return [];
  const source = best.sufficientData ? best.data : best.bestPerDay;
  return [...source]
    .sort((a, b) => b.score - a.score || a.weekday - b.weekday || a.hour - b.hour)
    .slice(0, limit);
}

/** The browser's IANA time zone (best times are reported in it), or UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A slot's weekday and hour in the locale's words ("Tue" / "08:00"); the same reading as the
 * publish panel's suggestion (review/publish-panel.tsx bestTimeParts).
 */
export function slotParts(
  slot: Pick<BestSlot, 'weekday' | 'hour'>,
  f: StudioFormat,
): { day: string; time: string } {
  // 7 January 2024 was a Sunday: add the weekday to reach that day of the week.
  const at = new Date(2024, 0, 7 + slot.weekday, slot.hour, 0).toISOString();
  return {
    day: f.date(at, { weekday: 'long' }),
    time: f.date(at, { hour: '2-digit', minute: '2-digit' }),
  };
}
