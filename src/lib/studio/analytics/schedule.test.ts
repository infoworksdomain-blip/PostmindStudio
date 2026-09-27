import { describe, expect, it } from 'vitest';
import { bucketStart, nextPollDelayMs, POLLING_WINDOWS } from './schedule';

// BACKLOG 11.1 / spec 15.2 windows:
//   0-5 min: every 30s · 5-60 min: every 5 min · 1-6h: every 15 min · 6-48h: hourly
//   day 3-30: daily · month 2-12: weekly · after 12 months: stop.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const PUBLISHED_AT = new Date('2026-01-01T00:00:00Z');

function delayAt(ageMs: number): number | null {
  return nextPollDelayMs(PUBLISHED_AT, PUBLISHED_AT.getTime() + ageMs);
}

describe('nextPollDelayMs', () => {
  it('polls every 30s at age 0', () => {
    expect(delayAt(0)).toBe(30 * SEC);
  });

  it('still polls every 30s just under the 5 minute boundary', () => {
    expect(delayAt(4 * MIN + 59 * SEC)).toBe(30 * SEC);
  });

  it('switches to every 5 minutes exactly at the 5 minute boundary', () => {
    expect(delayAt(5 * MIN)).toBe(5 * MIN);
  });

  it('still polls every 5 minutes just under the 60 minute boundary', () => {
    expect(delayAt(59 * MIN)).toBe(5 * MIN);
  });

  it('switches to every 15 minutes exactly at the 1 hour boundary', () => {
    expect(delayAt(HOUR)).toBe(15 * MIN);
  });

  it('still polls every 15 minutes just under the 6 hour boundary', () => {
    expect(delayAt(5 * HOUR + 59 * MIN)).toBe(15 * MIN);
  });

  it('switches to hourly exactly at the 6 hour boundary', () => {
    expect(delayAt(6 * HOUR)).toBe(HOUR);
  });

  it('still polls hourly just under the 48 hour boundary', () => {
    expect(delayAt(47 * HOUR + 59 * MIN)).toBe(HOUR);
  });

  it('switches to daily exactly at the 48 hour boundary', () => {
    expect(delayAt(48 * HOUR)).toBe(DAY);
  });

  it('still polls daily at day 29', () => {
    expect(delayAt(29 * DAY)).toBe(DAY);
  });

  it('switches to weekly exactly at day 30', () => {
    expect(delayAt(30 * DAY)).toBe(7 * DAY);
  });

  it('still polls weekly (not yet stopped) at day 364, clamped to the 1 day left', () => {
    // A plain 7-day tick would overshoot the 365-day cutoff, so the delay is clamped down to
    // the time actually remaining in the schedule.
    expect(delayAt(364 * DAY)).toBe(DAY);
  });

  it('polls weekly with the full 7 day delay well before the end of the schedule', () => {
    expect(delayAt(300 * DAY)).toBe(7 * DAY);
  });

  it('stops polling at day 365 (12 months)', () => {
    expect(delayAt(365 * DAY)).toBeNull();
  });

  it('stops polling well past the schedule end', () => {
    expect(delayAt(400 * DAY)).toBeNull();
  });

  it('never schedules a delay that runs past the end of the whole schedule', () => {
    const lastWindow = POLLING_WINDOWS[POLLING_WINDOWS.length - 1] as { untilMs: number };
    // One weekly tick before the 365-day cutoff: a plain 7-day delay would overshoot the end,
    // so the delay must be clamped down to the remaining time (but never below 1s).
    const age = lastWindow.untilMs - 2 * DAY;
    const delay = delayAt(age);
    expect(delay).not.toBeNull();
    expect(age + (delay as number)).toBeLessThanOrEqual(lastWindow.untilMs);
  });

  it('clamps the delay to at least 1 second when almost at the schedule end', () => {
    const lastWindow = POLLING_WINDOWS[POLLING_WINDOWS.length - 1] as { untilMs: number };
    const age = lastWindow.untilMs - 1;
    expect(delayAt(age)).toBe(SEC);
  });

  it('treats a publish time in the future as age zero', () => {
    const future = new Date(PUBLISHED_AT.getTime() + HOUR);
    expect(nextPollDelayMs(future, PUBLISHED_AT.getTime())).toBe(30 * SEC);
  });
});

describe('bucketStart', () => {
  it('truncates to the start of the UTC hour', () => {
    const at = new Date('2026-03-15T13:47:22.123Z');
    expect(bucketStart(at, 'hour').toISOString()).toBe('2026-03-15T13:00:00.000Z');
  });

  it('truncates to the start of the UTC day', () => {
    const at = new Date('2026-03-15T13:47:22.123Z');
    expect(bucketStart(at, 'day').toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('is idempotent for an already-truncated hour bucket', () => {
    const at = new Date('2026-03-15T13:00:00.000Z');
    expect(bucketStart(at, 'hour').toISOString()).toBe('2026-03-15T13:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const at = new Date('2026-03-15T13:47:22.123Z');
    const before = at.toISOString();
    bucketStart(at, 'hour');
    expect(at.toISOString()).toBe(before);
  });
});
