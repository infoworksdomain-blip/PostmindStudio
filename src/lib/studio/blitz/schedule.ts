import type { PrismaClient } from '@prisma/client';
import { firstFreeSlot, heldSlots, parseSlots, type DripSlot } from '../services/drip-queue';

// 22.4 — "Schedule next free slot" for a kept card. With the business's posting times (drip
// queue) on, the approval takes the next free slot itself (automation/outbox.ts planSchedule:
// scheduledStartAt stays null). Without posting times, the card gets the next free one of two
// default times a day (12:00 and 18:00, Europe/London unless a queue says otherwise), skipping
// times already held by the queue, month plans or another scheduled video of the business.

export const DEFAULT_BLITZ_TIMEZONE = 'Europe/London';
export const DEFAULT_BLITZ_TIMES = ['12:00', '18:00'] as const;

export function defaultSlots(timezone = DEFAULT_BLITZ_TIMEZONE): DripSlot[] {
  return [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
    DEFAULT_BLITZ_TIMES.map((time) => ({ weekday, time, timezone })),
  );
}

type Db = Pick<
  PrismaClient,
  'dripQueue' | 'videoProject' | 'autoPublishOutbox' | 'contentPlanItem'
>;

/**
 * The scheduledStartAt to store for "next free slot": null when the drip queue decides at
 * approval, otherwise the next free default time.
 */
export async function nextFreeSlot(
  db: Db,
  scope: { organisationId: string; businessId: string },
  now: number,
): Promise<Date | null> {
  const queue = await db.dripQueue.findUnique({ where: { organisationId_businessId: scope } });
  const slots = queue?.enabled ? parseSlots(queue.slots) : [];
  if (slots.length > 0) return null;
  const [held, scheduled] = await Promise.all([
    heldSlots(db, scope, now),
    db.videoProject.findMany({
      where: { ...scope, deletedAt: null, scheduledStartAt: { gte: new Date(now) } },
      select: { scheduledStartAt: true },
    }),
  ]);
  const taken = [
    ...held.map((h) => h.slotAt),
    ...scheduled.flatMap((p) => (p.scheduledStartAt ? [p.scheduledStartAt] : [])),
  ];
  const at = firstFreeSlot(defaultSlots(), taken, now);
  return at === null ? null : new Date(at);
}
