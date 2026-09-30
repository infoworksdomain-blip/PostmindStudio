import type { Publication } from '@/lib/client/types';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';

// Pure date helpers for the calendar: a Monday-first month grid in the viewer's local time and
// publications bucketed by the day they go (or went) live.

export interface MonthRef {
  year: number;
  /** 0-11 */
  month: number;
}

export function monthOf(date: Date): MonthRef {
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const d = new Date(ref.year, ref.month + delta, 1);
  return monthOf(d);
}

/** Local calendar key, e.g. 2026-09-27. */
export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Whole weeks (Monday first) covering the month: 4-6 rows of 7 days. */
export function monthGrid(ref: MonthRef): Date[] {
  const first = new Date(ref.year, ref.month, 1);
  const lead = (first.getDay() + 6) % 7; // days since Monday
  const daysInMonth = new Date(ref.year, ref.month + 1, 0).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => new Date(ref.year, ref.month, 1 - lead + i));
}

/** [from, to) ISO window covering the whole grid, for GET /publications?from&to. */
export function gridWindow(ref: MonthRef): { from: string; to: string } {
  const days = monthGrid(ref);
  const first = days[0] as Date;
  const last = days[days.length - 1] as Date;
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { from: first.toISOString(), to: end.toISOString() };
}

/** When a publication sits on the calendar: published time if live, else its schedule. */
export function eventTime(p: Publication): string | null {
  return p.publishedAt ?? p.scheduledFor;
}

export function groupByDay(publications: Publication[]): Map<string, Publication[]> {
  const byDay = new Map<string, Publication[]>();
  const timed = publications
    .map((p) => ({ p, at: eventTime(p) }))
    .filter((e): e is { p: Publication; at: string } => e.at !== null)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const { p, at } of timed) {
    const key = dayKey(new Date(at));
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }
  return byDay;
}

/** 20.3: open drip-queue slots (ISO instants) bucketed by local day, in time order. */
export function groupOpenByDay(openSlots: ReadonlyArray<string>): Map<string, string[]> {
  const byDay = new Map<string, string[]>();
  for (const at of [...openSlots].sort()) {
    const key = dayKey(new Date(at));
    byDay.set(key, [...(byDay.get(key) ?? []), at]);
  }
  return byDay;
}

export function formatTime(iso: string, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(iso));
}

export function formatMonth(ref: MonthRef, locale: string = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(ref.year, ref.month, 1),
  );
}

/**
 * Weekday names in the locale, indexed like Date#getDay() (0 = Sunday). 2026-01-04 is a Sunday;
 * noon keeps the date stable in every time zone.
 */
export function weekdayNames(
  locale: string = DEFAULT_LOCALE,
  weekday: 'long' | 'short' = 'long',
): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2026, 0, 4 + i, 12)));
}

/** 13.9 drag-to-reschedule: the same local time of day, on another day. */
export function moveToDay(iso: string, day: Date): Date {
  const from = new Date(iso);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    from.getHours(),
    from.getMinutes(),
    from.getSeconds(),
  );
}

/** ISO → the value of an <input type="datetime-local"> (local time, minutes). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value → Date (local time); null when empty or invalid. */
export function fromLocalInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
