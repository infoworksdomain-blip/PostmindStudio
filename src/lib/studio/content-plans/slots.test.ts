import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import {
  availableSlots,
  capPerDay,
  dailyPostTimes,
  dailySlots,
  defaultStartDate,
  dripSlotsInWindow,
  formatLocalDate,
  localDateOf,
  MAX_POSTS_PER_DAY,
  parseLocalDate,
  PLAN_MIN_LEAD_MS,
  planWindow,
  postsPerDayFromDrip,
} from './slots';

const LONDON = 'Europe/London';
const iso = (ms: number) => new Date(ms).toISOString();

describe('20.9 plan slots', () => {
  it('parses and formats local dates, refusing impossible ones', () => {
    expect(parseLocalDate('2026-10-01')).toEqual({ year: 2026, month: 10, day: 1 });
    expect(formatLocalDate({ year: 2026, month: 2, day: 3 })).toBe('2026-02-03');
    expect(() => parseLocalDate('2026-02-30')).toThrow(ValidationError);
    expect(() => parseLocalDate('1 Oct')).toThrow(ValidationError);
  });

  it('gives 1–4 fixed daily times and clamps anything else', () => {
    expect(dailyPostTimes(1)).toEqual(['12:30']);
    expect(dailyPostTimes(4)).toHaveLength(4);
    expect(dailyPostTimes(9)).toHaveLength(MAX_POSTS_PER_DAY);
    expect(dailyPostTimes(0)).toEqual(['12:30']);
  });

  it('builds the window from local midnight across a DST change', () => {
    // 25 Oct 2026 BST ends; a 2-day window starting 25 Oct is 49 hours long.
    const w = planWindow({ year: 2026, month: 10, day: 25 }, 2, LONDON);
    expect(iso(w.windowStart)).toBe('2026-10-24T23:00:00.000Z');
    expect(iso(w.windowEnd)).toBe('2026-10-27T00:00:00.000Z');
  });

  it('lays out N posts a day at local times (3 days × 2 = 6)', () => {
    const slots = dailySlots({ year: 2026, month: 10, day: 5 }, 3, 2, LONDON);
    expect(slots.map(iso)).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-05T16:30:00.000Z',
      '2026-10-06T08:00:00.000Z',
      '2026-10-06T16:30:00.000Z',
      '2026-10-07T08:00:00.000Z',
      '2026-10-07T16:30:00.000Z',
    ]);
  });

  it('caps posts at 4 per local day', () => {
    const base = Date.parse('2026-10-05T07:00:00Z');
    const six = Array.from({ length: 6 }, (_, i) => base + i * 3_600_000);
    expect(capPerDay(six, LONDON)).toHaveLength(4);
  });

  it('takes the drip queue slots inside the window, at most 4 a day', () => {
    const slots = [
      ...['08:00', '10:00', '12:00', '14:00', '16:00'].map((time) => ({
        weekday: 1,
        time,
        timezone: LONDON,
      })),
      { weekday: 3, time: '12:30', timezone: LONDON },
    ];
    const window = planWindow({ year: 2026, month: 10, day: 5 }, 7, LONDON);
    const got = dripSlotsInWindow(slots, window, LONDON);
    // Monday 5 Oct: 4 of 5 (capped); Wednesday 7 Oct: 1. Monday 12 Oct is outside.
    expect(got).toHaveLength(5);
    expect(got.every((at) => at >= window.windowStart && at < window.windowEnd)).toBe(true);
  });

  it('drops held times and times too soon to generate', () => {
    const now = Date.parse('2026-10-05T07:00:00Z');
    const soon = now + PLAN_MIN_LEAD_MS - 1;
    const later = now + PLAN_MIN_LEAD_MS + 60_000;
    const held = later + 3_600_000;
    expect(availableSlots([soon, later, held], [new Date(held)], now)).toEqual([later]);
  });

  it('derives posts a day from weekly posting times', () => {
    expect(postsPerDayFromDrip(3)).toBe(1);
    expect(postsPerDayFromDrip(14)).toBe(2);
    expect(postsPerDayFromDrip(28)).toBe(4);
  });

  it('starts tomorrow, or after the latest active plan', () => {
    const now = Date.parse('2026-09-30T20:00:00Z');
    expect(formatLocalDate(defaultStartDate(now, LONDON))).toBe('2026-10-01');
    const busy = planWindow({ year: 2026, month: 10, day: 1 }, 30, LONDON).windowEnd;
    expect(formatLocalDate(defaultStartDate(now, LONDON, busy))).toBe('2026-10-31');
    expect(formatLocalDate(localDateOf(now, 'Asia/Tokyo'))).toBe('2026-10-01');
  });
});
