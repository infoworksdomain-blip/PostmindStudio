// How far ahead anything can be scheduled (POST /publications, PATCH /publications/:id, a
// project's scheduledStartAt). Pure and dependency-free so the Create and Review screens apply the
// same rule the API enforces.

export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_AHEAD_DAYS = 180;
export const MAX_SCHEDULE_AHEAD_MS = MAX_SCHEDULE_AHEAD_DAYS * 24 * 60 * 60 * 1000;

/** True when `atMs` is more than MAX_SCHEDULE_AHEAD_DAYS after `nowMs`. */
export function isBeyondScheduleWindow(atMs: number, nowMs: number): boolean {
  return atMs - nowMs > MAX_SCHEDULE_AHEAD_MS;
}
