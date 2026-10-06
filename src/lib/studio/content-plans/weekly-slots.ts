import { addDays, zonedToUtc } from '../automation/zoned-time';
import { dailyPostTimes, MAX_POSTS_PER_DAY } from '../posting-schedule';
import type { LocalDate } from './calendar-days';

// 22.5 — "N posts a week": the week's posts on evenly spaced days (3 a week → Mon / Wed / Fri of
// the period's first week, and so on), at the shared daily posting times (posting-schedule.ts),
// never more than MAX_POSTS_PER_DAY a day. 8–21 a week put 2 or 3 posts on some days.

/** Day offsets (0–6) and posts per day for `perWeek` posts spread over a week. */
export function weekPattern(perWeek: number): Array<{ day: number; posts: number }> {
  const n = Math.max(1, Math.min(7 * MAX_POSTS_PER_DAY, Math.round(perWeek)));
  const perDay = Array.from({ length: 7 }, () => 0);
  for (let k = 0; k < n; k += 1) {
    // Spread across the days first (k-th post on day floor(k * 7 / n) of each round of 7).
    const round = Math.floor(k / 7);
    const inRound = Math.min(7, n - round * 7);
    const index = k % 7;
    perDay[Math.floor((index * 7) / inRound)]! += 1;
  }
  return perDay.flatMap((posts, day) => (posts > 0 ? [{ day, posts }] : []));
}

export function weeklySlots(
  start: LocalDate,
  days: number,
  perWeek: number,
  timezone: string,
): number[] {
  const pattern = weekPattern(perWeek);
  const out: number[] = [];
  for (let week = 0; week * 7 < days; week += 1) {
    for (const { day, posts } of pattern) {
      const offset = week * 7 + day;
      if (offset >= days) continue;
      const date = addDays(start, offset);
      for (const time of dailyPostTimes(Math.min(MAX_POSTS_PER_DAY, posts))) {
        const [hour, minute] = time.split(':').map(Number) as [number, number];
        out.push(zonedToUtc({ ...date, hour, minute }, timezone));
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
