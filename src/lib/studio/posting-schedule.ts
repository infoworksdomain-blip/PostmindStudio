import { z } from 'zod';
import { addDays, isValidTimeZone, wallClock, zonedToUtc } from './automation/zoned-time';

// 20.14 — the drip queue's posting schedule (operator request 2026-10-01: "post every day, choose
// how many times a day and when; or let the system pick the times or post at intervals; max 4 a
// day; the same for N posts a week"). A schedule is the high-level choice the owner made; it
// RESOLVES to the weekly wall-clock slots the drip queue has always stored (weekday + HH:MM +
// IANA zone), so the outbox, the calendar's open slots and the month planner's "use my posting
// times" keep reading `drip_queues.slots` unchanged. Pure and dependency-light: the API, the
// calendar editor, onboarding and the demo all resolve schedules with these functions.
//
// Modes:
//   daily  — postsPerDay (1–4) on every chosen day (default every day; days can be skipped);
//   weekly — postsPerWeek (1–28) spread over the chosen days, at most 4 a day;
//   custom — the per-slot list edited by hand (Advanced); the slots are stored as given.
// Times of a posting day:
//   choose   — the owner's own times, ascending, at least MIN_POST_GAP_MINUTES apart;
//   system   — DAILY_POST_TIMES (the month planner's "N a day" times);
//   interval — 'user': every intervalMinutes from intervalStart; 'system': the day's posts spread
//              evenly across [windowStart, windowEnd] (default 08:00–21:00).

export const MIN_POSTS_PER_DAY = 1;
export const MAX_POSTS_PER_DAY = 4;
export const MAX_POSTS_PER_WEEK = 7 * MAX_POSTS_PER_DAY;
/**
 * DECISION: posts of one day are at least 30 minutes apart — the default platform stagger
 * (services/drip-queue.ts DEFAULT_STAGGER_MINUTES), so with the default stagger one post's
 * second platform goes out before the next post starts.
 */
export const MIN_POST_GAP_MINUTES = 30;
export const MIN_INTERVAL_MINUTES = MIN_POST_GAP_MINUTES;
export const MAX_INTERVAL_MINUTES = 12 * 60;
/** The interval choices the editor offers (minutes). */
export const INTERVAL_CHOICES = [30, 60, 90, 120, 180, 240, 300, 360, 480] as const;
export const DEFAULT_WINDOW_START = '08:00';
export const DEFAULT_WINDOW_END = '21:00';
export const DEFAULT_INTERVAL_START = '09:00';
export const DEFAULT_INTERVAL_MINUTES = 180;
/** 0 = Sunday … 6 = Saturday; the editor lists Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const ALL_DAYS: readonly number[] = WEEK_ORDER;
/** System times shown for "Next 7 days". */
export const PREVIEW_DAYS = 7;

/** Daily post times (HH:MM, local) for 1–4 posts a day — shared with the month planner. */
export const DAILY_POST_TIMES: Readonly<Record<number, readonly string[]>> = {
  1: ['12:30'],
  2: ['09:00', '17:30'],
  3: ['09:00', '12:30', '17:30'],
  4: ['09:00', '12:30', '17:30', '20:00'],
};

/** Default posting days for k posting days a week (3 → Mon/Wed/Fri, like the 20.3 plans). */
export const DEFAULT_WEEK_DAYS: Readonly<Record<number, readonly number[]>> = {
  1: [3],
  2: [2, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
  6: [1, 2, 3, 4, 5, 6],
  7: [1, 2, 3, 4, 5, 6, 0],
};

export const SCHEDULE_MODES = ['daily', 'weekly', 'custom'] as const;
export const TIMES_MODES = ['choose', 'system', 'interval'] as const;
export const INTERVAL_BY = ['user', 'system'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];
export type TimesMode = (typeof TIMES_MODES)[number];
export type IntervalBy = (typeof INTERVAL_BY)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeString = z.string().regex(HHMM, 'time must be HH:MM (24-hour)');
export const timezoneString = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'timezone must be an IANA time zone' });

export const slotSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    time: timeString,
    timezone: timezoneString,
  })
  .strict();

export type DripSlot = z.infer<typeof slotSchema>;

/** The stored/sent schedule. Every field has a default so a partial body still parses. */
export const postingScheduleSchema = z
  .object({
    mode: z.enum(SCHEDULE_MODES),
    timezone: timezoneString,
    postsPerDay: z.number().int().min(MIN_POSTS_PER_DAY).max(MAX_POSTS_PER_DAY).default(1),
    postsPerWeek: z.number().int().min(1).max(MAX_POSTS_PER_WEEK).default(3),
    days: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .default([...ALL_DAYS]),
    timesMode: z.enum(TIMES_MODES).default('system'),
    times: z.array(timeString).max(MAX_POSTS_PER_DAY).default([]),
    intervalBy: z.enum(INTERVAL_BY).default('user'),
    intervalStart: timeString.default(DEFAULT_INTERVAL_START),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .default(DEFAULT_INTERVAL_MINUTES),
    windowStart: timeString.default(DEFAULT_WINDOW_START),
    windowEnd: timeString.default(DEFAULT_WINDOW_END),
  })
  .strict();

export type PostingSchedule = z.output<typeof postingScheduleSchema>;

export type ScheduleProblem =
  | 'days_empty'
  | 'days_duplicate'
  | 'week_too_many'
  | 'week_too_few'
  | 'times_count'
  | 'times_order'
  | 'times_gap'
  | 'interval_overflow'
  | 'window_order'
  | 'window_too_short';

/** English messages (API validation); the editor shows its own translated copy per code. */
export const SCHEDULE_PROBLEM_MESSAGES: Record<ScheduleProblem, string> = {
  days_empty: 'Choose at least one posting day',
  days_duplicate: 'Each posting day can be chosen once',
  week_too_many: `At most ${MAX_POSTS_PER_DAY} posts a day: choose more days or fewer posts a week`,
  week_too_few: 'Fewer posts a week than posting days: choose fewer days or more posts',
  times_count: 'Give one time for each post of the day',
  times_order: 'Post times must be in order, earliest first',
  times_gap: `Posts of a day must be at least ${MIN_POST_GAP_MINUTES} minutes apart`,
  interval_overflow: 'The interval runs past midnight: start earlier or post less often',
  window_order: 'The posting window must end after it starts',
  window_too_short: `The posting window is too short to keep posts ${MIN_POST_GAP_MINUTES} minutes apart`,
};

// ------------------------------------------------------------------ helpers

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const clampPerDay = (n: number) =>
  Math.min(MAX_POSTS_PER_DAY, Math.max(MIN_POSTS_PER_DAY, Math.round(n)));

/** The month planner's fixed times for 1–4 posts a day. */
export function dailyPostTimes(postsPerDay: number): readonly string[] {
  return DAILY_POST_TIMES[clampPerDay(postsPerDay)] ?? DAILY_POST_TIMES[1]!;
}

/** Weekdays in Monday-first order, de-duplicated. */
export function sortDays(days: readonly number[]): number[] {
  const set = new Set(days);
  return WEEK_ORDER.filter((d) => set.has(d));
}

/** Default posting days for `postsPerWeek` posts (never more than 7 days). */
export function defaultWeekDays(postsPerWeek: number): number[] {
  const k = Math.min(7, Math.max(1, Math.round(postsPerWeek)));
  return [...(DEFAULT_WEEK_DAYS[k] ?? DEFAULT_WEEK_DAYS[3]!)];
}

/** `count` posts spread evenly over [start, end] (one post: the middle), on 5-minute marks. */
export function spreadInWindow(count: number, start: string, end: string): string[] {
  const a = toMinutes(start);
  const b = toMinutes(end);
  const n = clampPerDay(count);
  if (n === 1) return [fromMinutes(Math.floor((a + b) / 2 / 5) * 5)];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) =>
    fromMinutes(i === n - 1 ? b : Math.floor((a + i * step) / 5) * 5),
  );
}

/** Posts on each posting day: weekday → count (Monday-first insertion order). */
export function postsByDay(schedule: PostingSchedule): Map<number, number> {
  const days = sortDays(schedule.days);
  const out = new Map<number, number>();
  if (schedule.mode === 'daily') {
    for (const d of days) out.set(d, clampPerDay(schedule.postsPerDay));
    return out;
  }
  // weekly: N over k days — floor(N/k) each, the remainder spread evenly (not bunched at the
  // start of the week): day i gets one more when ⌊(i+1)·r/k⌋ > ⌊i·r/k⌋.
  const k = days.length;
  if (k === 0) return out;
  const n = schedule.postsPerWeek;
  const base = Math.floor(n / k);
  const extra = n % k;
  days.forEach((d, i) => {
    const more = Math.floor(((i + 1) * extra) / k) > Math.floor((i * extra) / k) ? 1 : 0;
    out.set(d, Math.min(MAX_POSTS_PER_DAY, base + more));
  });
  return out;
}

/** The most posts any posting day has (the number of time inputs "choose" shows). */
export function maxPostsPerDay(schedule: PostingSchedule): number {
  if (schedule.mode === 'daily') return clampPerDay(schedule.postsPerDay);
  const counts = [...postsByDay(schedule).values()];
  return counts.length ? Math.max(...counts) : clampPerDay(schedule.postsPerWeek);
}

/** The post times of a day with `count` posts. Assumes a valid schedule. */
export function timesForDay(schedule: PostingSchedule, count: number): string[] {
  const n = clampPerDay(count);
  if (schedule.timesMode === 'choose') return schedule.times.slice(0, n);
  if (schedule.timesMode === 'system') return [...dailyPostTimes(n)];
  if (schedule.intervalBy === 'system')
    return spreadInWindow(n, schedule.windowStart, schedule.windowEnd);
  const start = toMinutes(schedule.intervalStart);
  return Array.from({ length: n }, (_, i) => fromMinutes(start + i * schedule.intervalMinutes));
}

function timesProblems(times: string[]): ScheduleProblem[] {
  const mins = times.map(toMinutes);
  for (let i = 1; i < mins.length; i += 1) {
    if (mins[i]! <= mins[i - 1]!) return ['times_order'];
    if (mins[i]! - mins[i - 1]! < MIN_POST_GAP_MINUTES) return ['times_gap'];
  }
  return [];
}

/** Everything wrong with a simple (daily/weekly) schedule; [] when it resolves. */
export function scheduleProblems(schedule: PostingSchedule): ScheduleProblem[] {
  if (schedule.mode === 'custom') return [];
  const problems: ScheduleProblem[] = [];
  const days = sortDays(schedule.days);
  if (days.length === 0) return ['days_empty'];
  if (days.length !== schedule.days.length) problems.push('days_duplicate');
  if (schedule.mode === 'weekly') {
    if (schedule.postsPerWeek > days.length * MAX_POSTS_PER_DAY) problems.push('week_too_many');
    if (schedule.postsPerWeek < days.length) problems.push('week_too_few');
  }
  const max = maxPostsPerDay(schedule);
  if (schedule.timesMode === 'choose') {
    if (schedule.times.length !== max) problems.push('times_count');
    else problems.push(...timesProblems(schedule.times));
  } else if (schedule.timesMode === 'interval') {
    if (schedule.intervalBy === 'user') {
      const last = toMinutes(schedule.intervalStart) + (max - 1) * schedule.intervalMinutes;
      if (last >= 24 * 60) problems.push('interval_overflow');
    } else {
      const span = toMinutes(schedule.windowEnd) - toMinutes(schedule.windowStart);
      if (span <= 0) problems.push('window_order');
      else if (timesProblems(timesForDay(schedule, max)).length) problems.push('window_too_short');
    }
  }
  return problems;
}

/**
 * The weekly drip slots of a daily/weekly schedule (Monday first, times ascending); at most
 * MAX_POSTS_PER_DAY a weekday and so at most MAX_POSTS_PER_WEEK. Throws on an invalid schedule
 * (check scheduleProblems first); a custom schedule has no slots of its own.
 */
export function resolveSchedule(schedule: PostingSchedule): DripSlot[] {
  if (schedule.mode === 'custom') throw new Error('A custom schedule keeps its own slots');
  const problems = scheduleProblems(schedule);
  if (problems.length) throw new Error(SCHEDULE_PROBLEM_MESSAGES[problems[0]!]);
  const slots: DripSlot[] = [];
  for (const [weekday, count] of postsByDay(schedule))
    for (const time of timesForDay(schedule, count))
      slots.push({ weekday, time, timezone: schedule.timezone });
  return slots;
}

/** A new schedule: every day, once a day, at the system's time. */
export function defaultSchedule(timezone: string): PostingSchedule {
  return {
    mode: 'daily',
    timezone,
    postsPerDay: 1,
    postsPerWeek: 3,
    days: [...ALL_DAYS],
    timesMode: 'system',
    times: [...dailyPostTimes(1)],
    intervalBy: 'user',
    intervalStart: DEFAULT_INTERVAL_START,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    windowStart: DEFAULT_WINDOW_START,
    windowEnd: DEFAULT_WINDOW_END,
  };
}

/**
 * `times` grown or shrunk to `count` entries for "I'll choose the times": kept times stay, and
 * missing ones come from the system times that are at least MIN_POST_GAP_MINUTES from every
 * kept time (falling back to the system times when the kept ones cannot be completed).
 */
export function fitTimes(times: readonly string[], count: number): string[] {
  const n = clampPerDay(count);
  const kept = [...new Set(times)].sort((a, b) => toMinutes(a) - toMinutes(b));
  if (kept.length >= n) return kept.slice(0, n);
  const out = [...kept];
  for (const candidate of [...dailyPostTimes(4), '07:00', '15:00', '22:00']) {
    if (out.length >= n) break;
    const c = toMinutes(candidate);
    if (out.every((t) => Math.abs(toMinutes(t) - c) >= MIN_POST_GAP_MINUTES)) out.push(candidate);
  }
  const sorted = out.sort((a, b) => toMinutes(a) - toMinutes(b));
  return sorted.length === n && timesProblems(sorted).length === 0
    ? sorted
    : [...dailyPostTimes(n)];
}

/**
 * The simple schedule stored slots are exactly (a migrated pre-20.14 queue), or null: one time
 * zone and the same times on every posting day → daily (every day) or weekly "I'll choose".
 */
export function inferSchedule(slots: readonly DripSlot[]): PostingSchedule | null {
  const zone = slots[0]?.timezone;
  if (!zone || slots.some((s) => s.timezone !== zone)) return null;
  const byDay = new Map<number, string[]>();
  for (const s of slots) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s.time]);
  const lists = [...byDay.values()].map((l) => l.sort((a, b) => toMinutes(a) - toMinutes(b)));
  const times = lists[0]!;
  if (times.length > MAX_POSTS_PER_DAY || lists.some((l) => l.join() !== times.join())) return null;
  const days = sortDays([...byDay.keys()]);
  const base = defaultSchedule(zone);
  const candidate: PostingSchedule =
    days.length === 7
      ? { ...base, postsPerDay: times.length, timesMode: 'choose', times }
      : {
          ...base,
          mode: 'weekly',
          postsPerWeek: times.length * days.length,
          days,
          timesMode: 'choose',
          times,
        };
  return scheduleProblems(candidate).length === 0 ? candidate : null;
}

/** Slots after `fromMs` within `days` days, ascending, de-duplicated (DST-safe). */
export function upcomingSlots(slots: DripSlot[], fromMs: number, horizonDays: number): number[] {
  const out = new Set<number>();
  for (const slot of slots) {
    const [hour, minute] = slot.time.split(':').map(Number) as [number, number];
    const today = wallClock(fromMs, slot.timezone);
    for (let d = 0; d <= horizonDays; d += 1) {
      const date = addDays(today, d);
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (weekday !== slot.weekday) continue;
      const at = zonedToUtc({ ...date, hour, minute }, slot.timezone);
      if (at > fromMs) out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** "Next 7 days": the post times in [fromMs, fromMs + days). */
export function previewTimes(slots: DripSlot[], fromMs: number, days = PREVIEW_DAYS): number[] {
  const end = fromMs + days * 86_400_000;
  return upcomingSlots(slots, fromMs, days).filter((at) => at < end);
}

/** At most MAX_POSTS_PER_DAY slots on any weekday (custom lists too). */
export function slotsWithinDailyCap(slots: readonly DripSlot[]): boolean {
  const per = new Map<number, number>();
  for (const s of slots) per.set(s.weekday, (per.get(s.weekday) ?? 0) + 1);
  return [...per.values()].every((n) => n <= MAX_POSTS_PER_DAY);
}
