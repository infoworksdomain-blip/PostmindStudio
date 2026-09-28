import { describe, expect, it } from 'vitest';
import { addDays, isValidTimeZone, nextMidnight, wallClock, zonedToUtc } from './zoned-time';

describe('zoned-time', () => {
  it('reads the wall clock in a time zone', () => {
    const w = wallClock(Date.parse('2026-10-05T07:30:00Z'), 'Europe/London');
    expect(w).toMatchObject({ year: 2026, month: 10, day: 5, hour: 8, minute: 30, weekday: 1 });
  });

  it('converts local time to UTC across the BST/GMT change', () => {
    const summer = zonedToUtc(
      { year: 2026, month: 10, day: 19, hour: 8, minute: 30 },
      'Europe/London',
    );
    const winter = zonedToUtc(
      { year: 2026, month: 10, day: 26, hour: 8, minute: 30 },
      'Europe/London',
    );
    expect(new Date(summer).toISOString()).toBe('2026-10-19T07:30:00.000Z');
    expect(new Date(winter).toISOString()).toBe('2026-10-26T08:30:00.000Z');
  });

  it('resolves a time skipped by spring-forward to a real instant', () => {
    const at = zonedToUtc({ year: 2027, month: 3, day: 28, hour: 1, minute: 30 }, 'Europe/London');
    expect(Number.isFinite(at)).toBe(true);
  });

  it('finds the next Pacific midnight (YouTube quota reset)', () => {
    const next = nextMidnight(Date.parse('2026-09-28T20:00:00Z'), 'America/Los_Angeles');
    expect(new Date(next).toISOString()).toBe('2026-09-29T07:00:00.000Z');
    const winter = nextMidnight(Date.parse('2026-12-01T12:00:00Z'), 'America/Los_Angeles');
    expect(new Date(winter).toISOString()).toBe('2026-12-02T08:00:00.000Z');
  });

  it('adds calendar days and validates zones', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(() => wallClock(0, 'Mars/Base')).toThrow();
  });
});
