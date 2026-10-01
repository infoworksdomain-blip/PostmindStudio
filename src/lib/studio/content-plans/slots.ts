import { ValidationError } from '../../errors';
import { addDays, wallClock, zonedToUtc } from '../automation/zoned-time';
import {
  DAILY_POST_TIMES,
  dailyPostTimes,
  MAX_POSTS_PER_DAY,
  MIN_POSTS_PER_DAY,
} from '../posting-schedule';
import { upcomingSlots, type DripSlot } from '../services/drip-queue';
import type { LocalDate } from './calendar-days';

// 20.9 — when a month plan's posts go out. DECISION (documented in PROGRESS 20.9): each item gets
// an explicit post time (project.scheduledStartAt) when the plan is drafted, instead of taking
// the drip queue's next free slot at approval time. The drip queue hands slots out in approval
// order, so a month generated in parallel would land in random order (Halloween after Bonfire
// Night) and could not exceed the queue's weekly slots; explicit times keep each topic on its
// day and work for businesses with no posting times at all. The plan's times are then counted as
// held drip slots (services/drip-queue.ts heldSlots), so the queue never gives them to another
// video, and they never change the owner's saved posting times.
//
// Times: "use my posting times" takes the business's drip-queue slots inside the window; "N a
// day" uses the fixed daily times below in the plan's time zone (weekday lunchtime / morning like
// the 20.3 presets, then early evening and evening). Never more than MAX_POSTS_PER_DAY a day.

// 20.14: the daily times and the 4-a-day cap live in posting-schedule.ts, shared with the drip
// queue's "Pick times for me", so "N a day" here and a daily posting schedule give the same times.
export { DAILY_POST_TIMES, dailyPostTimes, MAX_POSTS_PER_DAY, MIN_POSTS_PER_DAY };
export const DEFAULT_PLAN_DAYS = 30;
export const MAX_PLAN_DAYS = 31;
/** A post time closer than this is skipped: the item needs time to be generated first. */
export const PLAN_MIN_LEAD_MS = 2 * 60 * 60_000;
const DAY_MS = 86_400_000;

/** "2026-10-01" → { 2026, 10, 1 }; throws ValidationError for anything else. */
export function parseLocalDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ValidationError('startDate must be YYYY-MM-DD');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    throw new ValidationError('startDate is not a real date');
  return { year, month, day };
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** [local midnight of `start`, local midnight `days` later) in `timezone`, as instants. */
export function planWindow(
  start: LocalDate,
  days: number,
  timezone: string,
): { windowStart: number; windowEnd: number } {
  return {
    windowStart: zonedToUtc({ ...start, hour: 0, minute: 0 }, timezone),
    windowEnd: zonedToUtc({ ...addDays(start, days), hour: 0, minute: 0 }, timezone),
  };
}

/** The local date of an instant in `timezone`. */
export function localDateOf(ms: number, timezone: string): LocalDate {
  const w = wallClock(ms, timezone);
  return { year: w.year, month: w.month, day: w.day };
}

/** postsPerDay fixed times on each of `days` days from `start`, ascending. */
export function dailySlots(
  start: LocalDate,
  days: number,
  postsPerDay: number,
  timezone: string,
): number[] {
  const times = dailyPostTimes(postsPerDay);
  const out: number[] = [];
  for (let d = 0; d < days; d += 1) {
    const date = addDays(start, d);
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number) as [number, number];
      out.push(zonedToUtc({ ...date, hour, minute }, timezone));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Keep at most `max` instants per local day (the earliest ones). Input ascending. */
export function capPerDay(instants: number[], timezone: string, max = MAX_POSTS_PER_DAY): number[] {
  const perDay = new Map<string, number>();
  const out: number[] = [];
  for (const at of instants) {
    const key = formatLocalDate(localDateOf(at, timezone));
    const count = perDay.get(key) ?? 0;
    if (count >= max) continue;
    perDay.set(key, count + 1);
    out.push(at);
  }
  return out;
}

/** The business's weekly drip-queue slots inside the window, ≤ MAX_POSTS_PER_DAY a day. */
export function dripSlotsInWindow(
  slots: DripSlot[],
  window: { windowStart: number; windowEnd: number },
  timezone: string,
): number[] {
  const days = Math.ceil((window.windowEnd - window.windowStart) / DAY_MS) + 1;
  const all = upcomingSlots(slots, window.windowStart - 1, days).filter(
    (at) => at >= window.windowStart && at < window.windowEnd,
  );
  return capPerDay(all, timezone);
}

/** Drop times another video already holds and times too soon to generate for. */
export function availableSlots(candidates: number[], held: Date[], now: number): number[] {
  const taken = new Set(held.map((d) => d.getTime()));
  return candidates.filter((at) => at >= now + PLAN_MIN_LEAD_MS && !taken.has(at));
}

/** Posts a day that match a weekly drip queue (rounded, 1–4). */
export function postsPerDayFromDrip(slotsPerWeek: number): number {
  return Math.min(MAX_POSTS_PER_DAY, Math.max(MIN_POSTS_PER_DAY, Math.round(slotsPerWeek / 7)));
}

/**
 * Default start: tomorrow in `timezone`, or the day after the business's latest active plan
 * ends (its windowEnd), whichever is later — "the next free day".
 */
export function defaultStartDate(now: number, timezone: string, busyUntil?: number): LocalDate {
  const tomorrow = addDays(localDateOf(now, timezone), 1);
  if (busyUntil === undefined) return tomorrow;
  // windowEnd is local midnight, so its local date is the first free day.
  const free = localDateOf(busyUntil, timezone);
  return Date.UTC(free.year, free.month - 1, free.day) >
    Date.UTC(tomorrow.year, tomorrow.month - 1, tomorrow.day)
    ? free
    : tomorrow;
}
