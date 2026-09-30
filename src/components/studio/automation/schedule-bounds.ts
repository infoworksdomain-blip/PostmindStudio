import {
  isBeyondScheduleWindow,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_SCHEDULE_LEAD_MS,
} from '@/lib/studio/schedule-window';
import { fromLocalInput, toLocalInput } from '../calendar/month';

// 20.3 — the window a person can schedule in (lib/studio/schedule-window.ts, the API's rule) as
// <input type="datetime-local"> min / max values and a client-side check, so the Create and
// Review screens say "too far ahead" before the API answers 400.

export type ScheduleProblem = 'inPast' | 'tooFar';

/** min (a minute from now) and max (180 days from now) in the viewer's local time. */
export function scheduleInputBounds(now: number): { min: string; max: string } {
  return {
    min: toLocalInput(new Date(now + MIN_SCHEDULE_LEAD_MS).toISOString()),
    max: toLocalInput(new Date(now + MAX_SCHEDULE_AHEAD_MS).toISOString()),
  };
}

/** Why a datetime-local value cannot be scheduled (null = fine, or empty). */
export function scheduleProblem(value: string, now: number): ScheduleProblem | null {
  if (!value) return null;
  const at = fromLocalInput(value);
  if (!at || at.getTime() - now < MIN_SCHEDULE_LEAD_MS) return 'inPast';
  return isBeyondScheduleWindow(at.getTime(), now) ? 'tooFar' : null;
}
