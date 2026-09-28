import { ValidationError } from '../../errors';

// Wall-clock ↔ UTC conversion for IANA time zones with Intl only (no tz library). Used by the
// drip queue (15.A5: "every Monday 08:30 Europe/London" across DST changes), best-time
// suggestions (15.A6) and the YouTube quota reset (15.A9: midnight Pacific Time).

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock in `timeZone` at instant `ms`. */
export function wallClock(ms: number, timeZone: string): WallClock {
  if (!isValidTimeZone(timeZone)) throw new ValidationError(`Unknown time zone "${timeZone}"`);
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

function offsetMs(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which `timeZone` shows this wall-clock time. A time skipped by a DST jump
 * resolves to the same clock reading after the jump (e.g. 01:30 → 02:30 BST); an ambiguous
 * time (clocks going back) resolves to the first occurrence.
 */
export function zonedToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const first = guess - offsetMs(guess, timeZone);
  const second = guess - offsetMs(first, timeZone);
  // The earlier candidate that still reads as the requested time wins (first occurrence).
  const candidates = [first, second].sort((a, b) => a - b);
  for (const c of candidates) {
    const w = wallClock(c, timeZone);
    if (w.hour === local.hour && w.minute === local.minute && w.day === local.day) return c;
  }
  return second;
}

/** Add whole calendar days to a y/m/d (UTC arithmetic; no time zone involved). */
export function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Next local midnight in `timeZone` strictly after `ms` (e.g. YouTube quota reset, PT). */
export function nextMidnight(ms: number, timeZone: string): number {
  const today = wallClock(ms, timeZone);
  return zonedToUtc({ ...addDays(today, 1), hour: 0, minute: 0 }, timeZone);
}
