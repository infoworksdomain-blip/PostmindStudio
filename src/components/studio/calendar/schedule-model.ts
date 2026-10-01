import {
  ALL_DAYS,
  defaultSchedule,
  defaultWeekDays,
  fitTimes,
  inferSchedule,
  MAX_POSTS_PER_DAY,
  maxPostsPerDay,
  resolveSchedule,
  scheduleProblems,
  sortDays,
  timesForDay,
  type DripSlot,
  type PostingSchedule,
  type ScheduleProblem,
} from '@/lib/studio/posting-schedule';

// 20.14 — client-side state rules for the posting-schedule editor (calendar drip queue and the
// onboarding card). Pure: every change returns a new schedule; resolution and validation come
// from the shared posting-schedule module the API uses.

export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The schedule the editor opens with: the saved one, one inferred from the slots, or a default. */
export function initialSchedule(
  queue: { slots: DripSlot[]; schedule?: PostingSchedule | null } | null,
  zone: string = viewerZone(),
): PostingSchedule {
  if (queue?.schedule) return queue.schedule;
  if (!queue || queue.slots.length === 0) return defaultSchedule(zone);
  return (
    inferSchedule(queue.slots) ?? {
      ...defaultSchedule(queue.slots[0]!.timezone),
      mode: 'custom',
    }
  );
}

/** Keep "I'll choose" inputs in step with the posts of the busiest day. */
function fit(s: PostingSchedule): PostingSchedule {
  if (s.timesMode !== 'choose' || s.mode === 'custom') return s;
  const max = maxPostsPerDay(s);
  return s.times.length === max ? s : { ...s, times: fitTimes(s.times, max) };
}

const weekFits = (n: number, days: readonly number[]) =>
  days.length > 0 && days.length <= n && n <= days.length * MAX_POSTS_PER_DAY;

export function setMode(s: PostingSchedule, mode: 'daily' | 'weekly'): PostingSchedule {
  if (mode === 'daily')
    return fit({ ...s, mode, days: s.mode === 'daily' && s.days.length ? s.days : [...ALL_DAYS] });
  const days = weekFits(s.postsPerWeek, s.days) ? s.days : defaultWeekDays(s.postsPerWeek);
  return fit({ ...s, mode, days });
}

export function setPostsPerDay(s: PostingSchedule, n: number): PostingSchedule {
  return fit({ ...s, postsPerDay: n });
}

export function setPostsPerWeek(s: PostingSchedule, n: number): PostingSchedule {
  const days = weekFits(n, s.days) ? s.days : defaultWeekDays(n);
  return fit({ ...s, postsPerWeek: n, days });
}

/** The default days for the schedule's posts a week (the onboarding card has no day picker). */
export function withDefaultDays(s: PostingSchedule): PostingSchedule {
  return fit({ ...s, days: defaultWeekDays(s.postsPerWeek) });
}

export function toggleDay(s: PostingSchedule, weekday: number): PostingSchedule {
  const days = s.days.includes(weekday)
    ? s.days.filter((d) => d !== weekday)
    : sortDays([...s.days, weekday]);
  return fit({ ...s, days });
}

/** Switch how times are chosen; "choose" starts from the times the schedule shows now. */
export function setTimesMode(
  s: PostingSchedule,
  timesMode: PostingSchedule['timesMode'],
): PostingSchedule {
  if (timesMode === 'choose' && s.timesMode !== 'choose') {
    const shown = scheduleProblems(s).length === 0 ? timesForDay(s, maxPostsPerDay(s)) : s.times;
    return fit({ ...s, timesMode, times: [...shown] });
  }
  return fit({ ...s, timesMode });
}

export function setTime(s: PostingSchedule, index: number, time: string): PostingSchedule {
  return { ...s, times: s.times.map((t, i) => (i === index ? time : t)) };
}

export interface Resolved {
  problems: ScheduleProblem[];
  /** The weekly slots (empty while there are problems). */
  slots: DripSlot[];
}

/** Validate and resolve a simple schedule; custom schedules keep `customSlots`. */
export function resolveDraft(s: PostingSchedule, customSlots: DripSlot[]): Resolved {
  if (s.mode === 'custom') return { problems: [], slots: customSlots };
  const problems = scheduleProblems(s);
  return { problems, slots: problems.length ? [] : resolveSchedule(s) };
}

/** IANA zones for the selector (the current one always included). */
export function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const all = new Set([...zones, current, viewerZone(), 'UTC']);
  return [...all].sort();
}

/** "HH:MM" from a minutes count, for interval labels. */
export function intervalParts(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
