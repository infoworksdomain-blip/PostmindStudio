import { describe, expect, it } from 'vitest';
import {
  CALENDAR_DAY_IDS,
  CALENDAR_DAY_NAMES,
  calendarDaysBetween,
  calendarDaysOf,
  dateKey,
  easterSunday,
  nthWeekday,
} from './calendar-days';

describe('20.9 calendar days', () => {
  it('computes Easter Sunday (Gregorian computus) for known years', () => {
    expect(dateKey(easterSunday(2024))).toBe('2024-03-31');
    expect(dateKey(easterSunday(2025))).toBe('2025-04-20');
    expect(dateKey(easterSunday(2026))).toBe('2026-04-05');
    expect(dateKey(easterSunday(2027))).toBe('2027-03-28');
  });

  it('finds the n-th and the last weekday of a month', () => {
    // First Monday of May 2026 is 4 May; last Monday of May is 25 May; last Monday of August 31.
    expect(dateKey(nthWeekday(2026, 5, 1, 1))).toBe('2026-05-04');
    expect(dateKey(nthWeekday(2026, 5, 1, -1))).toBe('2026-05-25');
    expect(dateKey(nthWeekday(2026, 8, 1, -1))).toBe('2026-08-31');
    // Third Sunday of June 2026 (Father's Day) is 21 June.
    expect(dateKey(nthWeekday(2026, 6, 0, 3))).toBe('2026-06-21');
  });

  it('lists every calendar day of a year once, in date order, with a name', () => {
    const days = calendarDaysOf(2026);
    expect(days.map((d) => d.id).sort()).toEqual([...CALENDAR_DAY_IDS].sort());
    const keys = days.map((d) => dateKey(d.date));
    expect(keys).toEqual([...keys].sort());
    for (const id of CALENDAR_DAY_IDS) expect(CALENDAR_DAY_NAMES[id]).toBeTruthy();
  });

  it('places the movable UK days correctly in 2026', () => {
    const byId = Object.fromEntries(calendarDaysOf(2026).map((d) => [d.id, dateKey(d.date)]));
    expect(byId.mothers_day_uk).toBe('2026-03-15');
    expect(byId.pancake_day).toBe('2026-02-17');
    expect(byId.black_friday).toBe('2026-11-27');
    expect(byId.small_business_saturday).toBe('2026-12-05');
    expect(byId.halloween).toBe('2026-10-31');
  });

  it('returns only the days inside a window, across a year end', () => {
    const october = calendarDaysBetween({ year: 2026, month: 10, day: 1 }, 31).map((d) => d.id);
    expect(october).toEqual(['halloween']);
    const turn = calendarDaysBetween({ year: 2026, month: 12, day: 20 }, 14).map((d) => d.id);
    expect(turn).toEqual(['christmas_eve', 'christmas', 'boxing_day', 'new_years_eve', 'new_year']);
  });
});
