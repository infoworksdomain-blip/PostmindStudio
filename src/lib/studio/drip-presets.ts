// 20.3 — one-click posting plans for the drip queue ("3 a week", "5 a week", "Every day"). A plan
// only fills in weekly slots in the viewer's time zone; the person can change them before saving,
// and the saved slots are validated like any other (services/drip-queue.ts, ≤ MAX_DRIP_SLOTS).
// Pure and dependency-free: the calendar, onboarding and the demo all use it.
//
// DECISION: times follow common small-business posting advice without claiming more — lunchtime
// (12:30) on weekdays, a morning post (09:00) at weekends. Best-time suggestions (15.A6) stay
// advisory and separate.

export interface PresetSlot {
  /** 0 = Sunday … 6 = Saturday (Date#getDay). */
  weekday: number;
  /** HH:MM, 24-hour. */
  time: string;
  timezone: string;
}

/**
 * How many weeks ahead the drip queue looks for a free slot (services/drip-queue.ts
 * DRIP_HORIZON_DAYS = this × 7); here so client copy can say "the next 8 weeks".
 */
export const DRIP_HORIZON_WEEKS = 8;

export const DRIP_PRESET_IDS = ['three', 'five', 'daily'] as const;
export type DripPresetId = (typeof DRIP_PRESET_IDS)[number];

const WEEKDAY_TIME = '12:30';
const WEEKEND_TIME = '09:00';

const PRESET_DAYS: Record<DripPresetId, number[]> = {
  three: [1, 3, 5],
  five: [1, 2, 3, 4, 5],
  daily: [1, 2, 3, 4, 5, 6, 0],
};

const timeFor = (weekday: number) => (weekday === 0 || weekday === 6 ? WEEKEND_TIME : WEEKDAY_TIME);

/** The slots of a plan in `timezone` (Monday first). */
export function presetSlots(id: DripPresetId, timezone: string): PresetSlot[] {
  return PRESET_DAYS[id].map((weekday) => ({ weekday, time: timeFor(weekday), timezone }));
}

/** Posts per week of a plan. */
export function presetPostsPerWeek(id: DripPresetId): number {
  return PRESET_DAYS[id].length;
}

/** The plan these slots are exactly (any order, one time zone), or null. */
export function matchPreset(slots: ReadonlyArray<PresetSlot>): DripPresetId | null {
  const zone = slots[0]?.timezone;
  if (!zone) return null;
  const key = (s: Pick<PresetSlot, 'weekday' | 'time'>) => `${s.weekday}@${s.time}`;
  const have = new Set(slots.map(key));
  if (have.size !== slots.length || slots.some((s) => s.timezone !== zone)) return null;
  return (
    DRIP_PRESET_IDS.find((id) => {
      const want = presetSlots(id, zone);
      return want.length === have.size && want.every((s) => have.has(key(s)));
    }) ?? null
  );
}
