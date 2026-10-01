import { describe, expect, it } from 'vitest';
import {
  dailySlots,
  dripSlotsInWindow,
  planWindow,
  postsPerDayFromDrip,
} from './content-plans/slots';
import { presetSlots } from './drip-presets';
import {
  dailyPostTimes,
  defaultSchedule,
  defaultWeekDays,
  fitTimes,
  inferSchedule,
  MAX_POSTS_PER_WEEK,
  maxPostsPerDay,
  postingScheduleSchema,
  postsByDay,
  previewTimes,
  resolveSchedule,
  scheduleProblems,
  slotsWithinDailyCap,
  spreadInWindow,
  upcomingSlots,
  type PostingSchedule,
} from './posting-schedule';

const ZONE = 'Europe/London';
const daily = (over: Partial<PostingSchedule> = {}): PostingSchedule => ({
  ...defaultSchedule(ZONE),
  ...over,
});
const weekly = (over: Partial<PostingSchedule> = {}): PostingSchedule =>
  daily({ mode: 'weekly', postsPerWeek: 3, days: [1, 3, 5], ...over });
const keys = (s: PostingSchedule) => resolveSchedule(s).map((x) => `${x.weekday}@${x.time}`);

describe('posting schedule — daily (20.14)', () => {
  it('system times: the month planner’s 1–4 a day, every day, Monday first', () => {
    for (const n of [1, 2, 3, 4]) {
      const slots = resolveSchedule(daily({ postsPerDay: n }));
      expect(slots).toHaveLength(7 * n);
      expect(slots.filter((s) => s.weekday === 1).map((s) => s.time)).toEqual([
        ...dailyPostTimes(n),
      ]);
      expect(slots[0]!.weekday).toBe(1);
      expect(slots.every((s) => s.timezone === ZONE)).toBe(true);
    }
    expect(dailyPostTimes(4)).toEqual(['09:00', '12:30', '17:30', '20:00']);
  });

  it('I’ll choose: one time per post, in order and at least 30 minutes apart', () => {
    const ok = daily({ postsPerDay: 2, timesMode: 'choose', times: ['08:15', '19:45'] });
    expect(keys(ok).filter((k) => k.startsWith('3@'))).toEqual(['3@08:15', '3@19:45']);
    expect(scheduleProblems({ ...ok, times: ['08:15'] })).toEqual(['times_count']);
    expect(scheduleProblems({ ...ok, times: ['19:45', '08:15'] })).toEqual(['times_order']);
    expect(scheduleProblems({ ...ok, times: ['08:15', '08:15'] })).toEqual(['times_order']);
    expect(scheduleProblems({ ...ok, times: ['08:15', '08:44'] })).toEqual(['times_gap']);
    expect(scheduleProblems({ ...ok, times: ['08:15', '08:45'] })).toEqual([]);
  });

  it('every N hours from a start time, never past midnight', () => {
    const s = daily({ postsPerDay: 4, timesMode: 'interval', intervalStart: '09:00' });
    expect(keys(s).filter((k) => k.startsWith('1@'))).toEqual([
      '1@09:00',
      '1@12:00',
      '1@15:00',
      '1@18:00',
    ]);
    expect(
      scheduleProblems({ ...s, intervalStart: '15:00', intervalMinutes: 180 }), // 15, 18, 21, 24
    ).toEqual(['interval_overflow']);
    expect(scheduleProblems({ ...s, intervalStart: '14:59', intervalMinutes: 180 })).toEqual([]);
  });

  it('system interval: posts spread evenly across the posting window', () => {
    const s = daily({ postsPerDay: 4, timesMode: 'interval', intervalBy: 'system' });
    expect(keys(s).filter((k) => k.startsWith('2@'))).toEqual([
      '2@08:00',
      '2@12:20',
      '2@16:40',
      '2@21:00',
    ]);
    expect(spreadInWindow(1, '08:00', '21:00')).toEqual(['14:30']);
    expect(spreadInWindow(2, '10:00', '11:00')).toEqual(['10:00', '11:00']);
    expect(scheduleProblems({ ...s, windowStart: '21:00', windowEnd: '08:00' })).toEqual([
      'window_order',
    ]);
    expect(scheduleProblems({ ...s, windowStart: '08:00', windowEnd: '09:00' })).toEqual([
      'window_too_short',
    ]);
    expect(scheduleProblems({ ...s, windowStart: '08:00', windowEnd: '09:30' })).toEqual([]);
  });

  it('skipping days (e.g. Sundays) leaves those weekdays empty', () => {
    const s = daily({ postsPerDay: 2, days: [1, 2, 3, 4, 5, 6] });
    const slots = resolveSchedule(s);
    expect(slots).toHaveLength(12);
    expect(slots.some((x) => x.weekday === 0)).toBe(false);
    expect(scheduleProblems({ ...s, days: [] })).toEqual(['days_empty']);
    expect(scheduleProblems({ ...s, days: [1, 1] })).toContain('days_duplicate');
  });
});

describe('posting schedule — weekly (20.14)', () => {
  it('N a week on the chosen days, the remainder spread, never more than 4 a day', () => {
    expect(keys(weekly())).toEqual(['1@12:30', '3@12:30', '5@12:30']);
    const eight = weekly({ postsPerWeek: 8, days: [1, 2, 3, 4, 5] });
    expect([...postsByDay(eight).values()]).toEqual([1, 2, 1, 2, 2]);
    expect(resolveSchedule(eight)).toHaveLength(8);
    expect(maxPostsPerDay(eight)).toBe(2);
    const max = weekly({ postsPerWeek: MAX_POSTS_PER_WEEK, days: [0, 1, 2, 3, 4, 5, 6] });
    expect(resolveSchedule(max)).toHaveLength(28);
    expect(slotsWithinDailyCap(resolveSchedule(max))).toBe(true);
  });

  it('validates that N fits the chosen days', () => {
    expect(scheduleProblems(weekly({ postsPerWeek: 13, days: [1, 3, 5] }))).toEqual([
      'week_too_many',
    ]);
    expect(scheduleProblems(weekly({ postsPerWeek: 2, days: [1, 3, 5] }))).toEqual([
      'week_too_few',
    ]);
    expect(scheduleProblems(weekly({ postsPerWeek: 12, days: [1, 3, 5] }))).toEqual([]);
  });

  it('uses the same time options; a day with fewer posts takes the first chosen times', () => {
    const s = weekly({
      postsPerWeek: 5,
      days: [1, 3, 5],
      timesMode: 'choose',
      times: ['10:00', '16:00'],
    });
    expect(keys(s)).toEqual(['1@10:00', '3@10:00', '3@16:00', '5@10:00', '5@16:00']);
    const interval = weekly({ postsPerWeek: 6, timesMode: 'interval', intervalMinutes: 120 });
    expect(keys(interval).filter((k) => k.startsWith('1@'))).toEqual(['1@09:00', '1@11:00']);
  });

  it('default days spread across the week', () => {
    expect(defaultWeekDays(3)).toEqual([1, 3, 5]);
    expect(defaultWeekDays(5)).toEqual([1, 2, 3, 4, 5]);
    expect(defaultWeekDays(12)).toHaveLength(7);
    expect(defaultWeekDays(0)).toEqual([3]);
  });
});

describe('posting schedule — helpers (20.14)', () => {
  it('fitTimes keeps chosen times and fills the rest from the system times', () => {
    expect(fitTimes(['07:10'], 3)).toEqual(['07:10', '09:00', '12:30']);
    expect(fitTimes(['09:00', '12:30', '17:30'], 2)).toEqual(['09:00', '12:30']);
    expect(fitTimes([], 4)).toEqual([...dailyPostTimes(4)]);
    expect(fitTimes(['12:40', '12:40'], 2)).toEqual(['09:00', '12:40']);
  });

  it('infers the schedule of pre-20.14 slots, or null when there is none', () => {
    const three = inferSchedule(presetSlots('three', ZONE));
    expect(three).toMatchObject({
      mode: 'weekly',
      postsPerWeek: 3,
      days: [1, 3, 5],
      timesMode: 'choose',
      times: ['12:30'],
    });
    const every = inferSchedule(resolveSchedule(daily({ postsPerDay: 2 })));
    expect(every).toMatchObject({ mode: 'daily', postsPerDay: 2, times: ['09:00', '17:30'] });
    // The 20.3 "Every day" plan has different weekend times → not a simple schedule.
    expect(inferSchedule(presetSlots('daily', ZONE))).toBeNull();
    expect(inferSchedule([])).toBeNull();
    expect(
      inferSchedule([
        { weekday: 1, time: '09:00', timezone: ZONE },
        { weekday: 2, time: '09:00', timezone: 'UTC' },
      ]),
    ).toBeNull();
  });

  it('the zod schema fills defaults and rejects bad shapes', () => {
    const parsed = postingScheduleSchema.parse({ mode: 'daily', timezone: ZONE });
    expect(parsed).toEqual(daily({ times: [] }));
    expect(postingScheduleSchema.safeParse({ mode: 'daily', timezone: 'Mars/Base' }).success).toBe(
      false,
    );
    expect(
      postingScheduleSchema.safeParse({ mode: 'daily', timezone: ZONE, postsPerDay: 5 }).success,
    ).toBe(false);
    expect(
      postingScheduleSchema.safeParse({
        mode: 'weekly',
        timezone: ZONE,
        times: ['1:00'],
      }).success,
    ).toBe(false);
    expect(
      postingScheduleSchema.safeParse({ mode: 'daily', timezone: ZONE, intervalMinutes: 15 })
        .success,
    ).toBe(false);
    expect(() => resolveSchedule(daily({ days: [] }))).toThrow(/at least one posting day/);
    expect(() => resolveSchedule(daily({ mode: 'custom' }))).toThrow();
  });
});

describe('posting schedule — time zones and previews (20.14)', () => {
  it('keeps the wall-clock time across the October DST change', () => {
    const slots = resolveSchedule(daily({ postsPerDay: 1, timesMode: 'choose', times: ['09:00'] }));
    // Friday 2026-10-23 12:00 UTC; clocks go back on Sunday 2026-10-25.
    const from = Date.UTC(2026, 9, 23, 12);
    const times = upcomingSlots(slots, from, 4).map((ms) => new Date(ms).toISOString());
    expect(times).toEqual([
      '2026-10-24T08:00:00.000Z', // 09:00 BST
      '2026-10-25T09:00:00.000Z', // 09:00 GMT
      '2026-10-26T09:00:00.000Z',
      '2026-10-27T09:00:00.000Z',
    ]);
  });

  it('previews the next 7 days only', () => {
    const slots = resolveSchedule(daily({ postsPerDay: 2 }));
    const from = Date.UTC(2026, 9, 1, 10); // 11:00 BST, after the day's 09:00
    const preview = previewTimes(slots, from);
    expect(preview).toHaveLength(14); // 17:30 today, 6 full days, 09:00 on day 8 (< 7 × 24 h)
    expect(preview.every((ms) => ms > from && ms < from + 7 * 86_400_000)).toBe(true);
  });
});

describe('month planner consistency (20.14)', () => {
  const start = { year: 2026, month: 10, day: 5 };
  const window = planWindow(start, 7, ZONE);

  it('“N a day” and a daily schedule with system times give the same post times', () => {
    for (const n of [1, 2, 3, 4]) {
      const fromSchedule = dripSlotsInWindow(
        resolveSchedule(daily({ postsPerDay: n })),
        window,
        ZONE,
      );
      expect(fromSchedule).toEqual(dailySlots(start, 7, n, ZONE));
      expect(postsPerDayFromDrip(resolveSchedule(daily({ postsPerDay: n })).length)).toBe(n);
    }
  });

  it('“use my posting times” reads a weekly schedule’s resolved slots', () => {
    const s = weekly({
      postsPerWeek: 5,
      days: [1, 3, 5],
      timesMode: 'choose',
      times: ['10:00', '16:00'],
    });
    const times = dripSlotsInWindow(resolveSchedule(s), window, ZONE);
    expect(times).toHaveLength(5);
    expect(new Date(times[0]!).toISOString()).toBe('2026-10-05T09:00:00.000Z'); // Mon 10:00 BST
  });
});
