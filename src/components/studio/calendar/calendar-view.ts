import type { Publication } from '@/lib/client/types';
import { gridWindow, monthGrid, monthOf } from './month';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 25.9 — the calendar's view (month / week / day), the day it is anchored on and its
// filters, all kept in the URL (?view=&date=&platform=&status=&source=) so a view can be shared
// and survives a reload. Pure: the hook in use-calendar-url.ts reads and writes it.

export const CALENDAR_VIEWS = ['month', 'week', 'day'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** Publication states the calendar loads, plus month-plan posts still being made. */
export const STATUS_FILTERS = [
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'PLANNED',
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SOURCE_FILTERS = ['plan', 'automation', 'manual'] as const;
export type SourceFilter = (typeof SOURCE_FILTERS)[number];

export interface CalendarFilters {
  platform: string | null;
  status: StatusFilter | null;
  source: SourceFilter | null;
}

export interface CalendarUrlState {
  view: CalendarView;
  /** The anchor day as a local key (YYYY-MM-DD), or null for today. */
  date: string | null;
  filters: CalendarFilters;
}

export const NO_FILTERS: CalendarFilters = { platform: null, status: null, source: null };

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLATFORM_KEY = /^[a-z_]{1,32}$/;

function oneOf<T extends string>(list: readonly T[], value: string | null | undefined): T | null {
  return value && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/** A local day from its key; null when the key is not a real date. */
export function dateFromKey(key: string | null | undefined): Date | null {
  const m = key ? DATE_KEY.exec(key) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null;
}

/** Unknown or malformed values fall back to the defaults (month, today, no filters). */
export function parseCalendarParams(
  params: Pick<URLSearchParams, 'get'> | null | undefined,
): CalendarUrlState {
  const date = params?.get('date') ?? null;
  const platform = params?.get('platform') ?? null;
  return {
    view: oneOf(CALENDAR_VIEWS, params?.get('view')) ?? 'month',
    date: dateFromKey(date) ? date : null,
    filters: {
      platform: platform && PLATFORM_KEY.test(platform) ? platform : null,
      status: oneOf(STATUS_FILTERS, params?.get('status')),
      source: oneOf(SOURCE_FILTERS, params?.get('source')),
    },
  };
}

/** The query string for a state (defaults left out), keeping any other parameters. */
export function calendarSearch(
  state: CalendarUrlState,
  base: Pick<URLSearchParams, 'toString'> | null = null,
): string {
  const search = new URLSearchParams(base?.toString() ?? '');
  const set = (key: string, value: string | null) =>
    value ? search.set(key, value) : search.delete(key);
  set('view', state.view === 'month' ? null : state.view);
  set('date', state.date);
  set('platform', state.filters.platform);
  set('status', state.filters.status);
  set('source', state.filters.source);
  return search.toString();
}

export function hasFilters(filters: CalendarFilters): boolean {
  return Boolean(filters.platform || filters.status || filters.source);
}

/** Monday-first week holding `anchor`. */
export function weekDays(anchor: Date): Date[] {
  const lead = (anchor.getDay() + 6) % 7;
  return Array.from(
    { length: 7 },
    (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - lead + i),
  );
}

/** The days a view shows: the month's whole weeks, one week, or one day. */
export function viewDays(view: CalendarView, anchor: Date): Date[] {
  if (view === 'month') return monthGrid(monthOf(anchor));
  if (view === 'week') return weekDays(anchor);
  return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
}

/** [from, to) ISO window for GET /publications?from&to (local midnights, DST aware). */
export function viewWindow(view: CalendarView, anchor: Date): { from: string; to: string } {
  if (view === 'month') return gridWindow(monthOf(anchor));
  const days = viewDays(view, anchor);
  const first = days[0] as Date;
  const last = days[days.length - 1] as Date;
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { from: first.toISOString(), to: end.toISOString() };
}

/** The anchor one view-length earlier or later; a month keeps the day where it can. */
export function shiftAnchor(view: CalendarView, anchor: Date, delta: number): Date {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();
  if (view === 'week') return new Date(y, m, d + 7 * delta);
  if (view === 'day') return new Date(y, m, d + delta);
  const lastDay = new Date(y, m + delta + 1, 0).getDate();
  return new Date(y, m + delta, Math.min(d, lastDay));
}

/** Where a post came from (GET /publications `campaign`). */
export function sourceOf(publication: Pick<Publication, 'campaign'>): SourceFilter {
  const kind = publication.campaign?.kind;
  return kind === 'automation' ? 'automation' : kind === 'plan' ? 'plan' : 'manual';
}

export function publicationMatches(publication: Publication, filters: CalendarFilters): boolean {
  if (filters.platform && publication.platform !== filters.platform) return false;
  if (filters.status && publication.state !== filters.status) return false;
  if (filters.source && sourceOf(publication) !== filters.source) return false;
  return true;
}

/**
 * A month-plan post still being made has no platform yet: it hides under a platform filter or a
 * publication-state filter, and matches the plan / automation source it belongs to.
 */
export function plannedMatches(post: PlannedPost, filters: CalendarFilters): boolean {
  if (filters.platform) return false;
  if (filters.status && filters.status !== 'PLANNED') return false;
  if (filters.source) return filters.source === (post.automationId ? 'automation' : 'plan');
  return true;
}

/** Publications never match the "Planned" status filter: it means posts still being made. */
export function filterPublications(
  publications: readonly Publication[],
  filters: CalendarFilters,
): Publication[] {
  return publications.filter((p) => publicationMatches(p, filters));
}

/** Platforms present in the loaded posts, for the platform filter (sorted, distinct). */
export function platformsIn(publications: readonly Publication[], selected: string | null) {
  const set = new Set(publications.map((p) => p.platform));
  if (selected) set.add(selected);
  return [...set].sort();
}

/** The toolbar title: "October 2026", "5 – 11 Oct 2026" or "Monday 5 October 2026". */
export function viewTitle(view: CalendarView, anchor: Date, locale: string): string {
  if (view === 'month')
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
  if (view === 'day')
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(anchor);
  const days = weekDays(anchor);
  const format = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return format.formatRange(days[0] as Date, days[6] as Date);
}
