import { CALENDAR_DAY_NAMES, dateKey, type CalendarDay, type CalendarDayId } from './calendar-days';
import { formatLocalDate, localDateOf } from './slots';

// 20.9 — the shape of a month before Claude writes it: which slot is a video and which a
// slideshow (the owner's slider), and which angle each post takes (a varied mix: offers,
// how-tos, behind-the-scenes, testimonials, product features, seasonal). Deterministic, so the
// same inputs always give the same plan skeleton and the model only has to write the topics.

export const PLAN_ANGLES = [
  'how_to',
  'product_feature',
  'behind_the_scenes',
  'offer',
  'testimonial',
  'seasonal',
] as const;
export type PlanAngle = (typeof PLAN_ANGLES)[number];

/** The rotation for ordinary slots (seasonal slots come from the calendar). */
const ROTATION: readonly PlanAngle[] = [
  'how_to',
  'product_feature',
  'behind_the_scenes',
  'offer',
  'testimonial',
];

export type PlanKind = 'VIDEO' | 'SLIDESHOW';

export const DEFAULT_VIDEO_SHARE = 50;

/**
 * Spread videoShare % videos evenly through `count` slots (Bresenham): 50 alternates, 25 makes
 * every fourth a video, 0 and 100 are all one kind.
 */
export function assignKinds(count: number, videoShare: number): PlanKind[] {
  const share = Math.min(100, Math.max(0, videoShare));
  return Array.from({ length: count }, (_, i) =>
    Math.floor(((i + 1) * share) / 100) > Math.floor((i * share) / 100) ? 'VIDEO' : 'SLIDESHOW',
  );
}

export interface SkeletonItem {
  slotAt: number;
  kind: PlanKind;
  angle: PlanAngle;
  calendarDay: CalendarDayId | null;
}

/** How many days before a calendar day a seasonal post may go out when that day has no slot. */
export const SEASONAL_LEAD_DAYS = 3;

/**
 * One seasonal post per calendar day in the window: the first slot on that day, else the last slot
 * in the SEASONAL_LEAD_DAYS days before it. Returns slot index → calendar day.
 */
export function seasonalSlots(
  slots: number[],
  days: CalendarDay[],
  timezone: string,
): Map<number, CalendarDayId> {
  const keys = slots.map((at) => formatLocalDate(localDateOf(at, timezone)));
  const out = new Map<number, CalendarDayId>();
  for (const day of days) {
    const target = dateKey(day.date);
    let index = keys.findIndex((k) => k === target);
    if (index < 0) {
      const dayMs = Date.UTC(day.date.year, day.date.month - 1, day.date.day);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const [y, m, d] = keys[i]!.split('-').map(Number) as [number, number, number];
        const diff = (dayMs - Date.UTC(y, m - 1, d)) / 86_400_000;
        if (diff > 0 && diff <= SEASONAL_LEAD_DAYS) {
          index = i;
          break;
        }
      }
    }
    if (index >= 0 && !out.has(index)) out.set(index, day.id);
  }
  return out;
}

/** The skeleton: kind and angle per slot, never the same ordinary angle twice in a row. */
export function buildSkeleton(input: {
  slots: number[];
  videoShare: number;
  calendarDays: CalendarDay[];
  timezone: string;
}): SkeletonItem[] {
  const kinds = assignKinds(input.slots.length, input.videoShare);
  const seasonal = seasonalSlots(input.slots, input.calendarDays, input.timezone);
  let turn = 0;
  return input.slots.map((slotAt, i) => {
    const day = seasonal.get(i) ?? null;
    if (day) return { slotAt, kind: kinds[i]!, angle: 'seasonal', calendarDay: day };
    const angle = ROTATION[turn % ROTATION.length]!;
    turn += 1;
    return { slotAt, kind: kinds[i]!, angle, calendarDay: null };
  });
}

export function calendarDayName(id: string | null | undefined): string | null {
  if (!id) return null;
  return (CALENDAR_DAY_NAMES as Record<string, string>)[id] ?? null;
}
