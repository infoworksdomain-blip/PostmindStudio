import { describe, expect, it } from 'vitest';
import {
  isBeyondScheduleWindow,
  MAX_SCHEDULE_AHEAD_DAYS,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_SCHEDULE_LEAD_MS,
} from './schedule-window';

describe('schedule window (20.3)', () => {
  it('allows up to 180 days ahead', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(MAX_SCHEDULE_AHEAD_DAYS).toBe(180);
    expect(MIN_SCHEDULE_LEAD_MS).toBe(60_000);
    expect(isBeyondScheduleWindow(now + MAX_SCHEDULE_AHEAD_MS, now)).toBe(false);
    expect(isBeyondScheduleWindow(now + MAX_SCHEDULE_AHEAD_MS + 1, now)).toBe(true);
    expect(isBeyondScheduleWindow(now - 1, now)).toBe(false);
  });
});
