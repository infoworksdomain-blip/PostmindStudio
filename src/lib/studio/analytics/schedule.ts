// BACKLOG 11.1 / spec 15.2 — how often a publication's metrics are polled, by age:
//   0–5 min: every 30 s · 5–60 min: every 5 min · 1–6 h: every 15 min · 6–48 h: hourly
//   day 3–30: daily · month 2–12: weekly · after 12 months: stop.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const POLLING_WINDOWS: ReadonlyArray<{ untilMs: number; everyMs: number }> = [
  { untilMs: 5 * MIN, everyMs: 30 * SEC },
  { untilMs: 60 * MIN, everyMs: 5 * MIN },
  { untilMs: 6 * HOUR, everyMs: 15 * MIN },
  { untilMs: 48 * HOUR, everyMs: HOUR },
  { untilMs: 30 * DAY, everyMs: DAY },
  { untilMs: 365 * DAY, everyMs: 7 * DAY },
];

/** Delay until the next poll, or null when polling has finished (older than 12 months). */
export function nextPollDelayMs(publishedAt: Date, now: number): number | null {
  const age = Math.max(0, now - publishedAt.getTime());
  const window = POLLING_WINDOWS.find((w) => age < w.untilMs);
  if (!window) return null;
  // Never schedule past the end of the whole schedule.
  const last = POLLING_WINDOWS[POLLING_WINDOWS.length - 1] as { untilMs: number };
  return Math.min(window.everyMs, Math.max(SEC, last.untilMs - age));
}

/** Hour or day bucket start (UTC) for a timestamp. */
export function bucketStart(at: Date, size: 'hour' | 'day'): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  if (size === 'day') d.setUTCHours(0);
  return d;
}
