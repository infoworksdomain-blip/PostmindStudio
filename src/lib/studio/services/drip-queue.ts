import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { DRIP_HORIZON_WEEKS } from '../drip-presets';
import {
  MAX_POSTS_PER_DAY,
  postingScheduleSchema,
  resolveSchedule,
  SCHEDULE_PROBLEM_MESSAGES,
  scheduleProblems,
  slotSchema,
  slotsWithinDailyCap,
  upcomingSlots as upcomingScheduleSlots,
  type DripSlot,
  type PostingSchedule,
} from '../posting-schedule';
import { PLATFORMS } from './catalog';

// 15.A5 — per-business drip queue (spec 3.1 "Publish now, schedule to time, drip queue,
// auto-publish"; 9.9 "stagger by 15-60 minutes across platforms by default"). The spec names the
// feature, not its shape; this shape is DERIVED: weekly wall-clock slots in the business's time
// zone. An approved project with publishPolicy SCHEDULED and no scheduledStartAt takes the next
// slot no other approved video of the business holds (automation/outbox.ts writes the rows);
// each of its targets is then staggered STUDIO_DEFAULT_STAGGER_MINUTES apart.

export const MAX_DRIP_SLOTS = 28;
/**
 * How far ahead slots are searched (and createPublication's 180-day cap is far beyond it).
 * 20.3: must cover at least a month ahead (MONTH_AHEAD_DAYS); a test pins it.
 */
export const DRIP_HORIZON_DAYS = DRIP_HORIZON_WEEKS * 7;
/** 20.3: "plan a month ahead" — the shortest window the drip queue must be able to fill. */
export const MONTH_AHEAD_DAYS = 31;
/** 20.3: GET …/drip-queue/upcoming default window and its cap. */
export const DEFAULT_UPCOMING_DAYS = MONTH_AHEAD_DAYS;
export const MAX_UPCOMING_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;
/** A slot closer than this is skipped: the outbox needs time to create the publication. */
export const DRIP_MIN_LEAD_MS = 2 * 60_000;
export const DEFAULT_STAGGER_MINUTES = 30;
export const MIN_STAGGER_MINUTES = 15;
export const MAX_STAGGER_MINUTES = 60;

export type { DripSlot, PostingSchedule };

/**
 * 20.14: PUT body — `schedule` (daily/weekly) resolves to the slots on the server (any `slots`
 * sent with it are replaced by the resolved ones, so the stored slots always match the stored
 * schedule); `schedule.mode: 'custom'` or no schedule keeps the hand-edited `slots`. Every slot
 * list is at most MAX_DRIP_SLOTS and at most MAX_POSTS_PER_DAY on any weekday.
 */
export const dripQueueInput = z
  .object({
    slots: z.array(slotSchema).min(1).max(MAX_DRIP_SLOTS).optional(),
    schedule: postingScheduleSchema.optional(),
    platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    const simple = input.schedule && input.schedule.mode !== 'custom' ? input.schedule : null;
    if (simple) {
      for (const problem of scheduleProblems(simple))
        ctx.addIssue({
          code: 'custom',
          path: ['schedule'],
          message: SCHEDULE_PROBLEM_MESSAGES[problem],
          params: { code: problem },
        });
      return;
    }
    if (!input.slots) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots'],
        message: 'Send slots, or a daily or weekly schedule',
      });
      return;
    }
    if (!slotsWithinDailyCap(input.slots))
      ctx.addIssue({
        code: 'custom',
        path: ['slots'],
        message: `At most ${MAX_POSTS_PER_DAY} slots on any day`,
      });
  })
  .transform((input) => {
    const simple =
      input.schedule && input.schedule.mode !== 'custom' && !scheduleProblems(input.schedule).length
        ? input.schedule
        : null;
    const slots = simple ? resolveSchedule(simple) : (input.slots ?? []);
    // No schedule sent (pre-20.14 clients, the API): the hand-made slots are a custom schedule.
    const schedule: PostingSchedule =
      input.schedule ??
      postingScheduleSchema.parse({ mode: 'custom', timezone: slots[0]?.timezone ?? 'UTC' });
    return { platforms: input.platforms, enabled: input.enabled, schedule, slots };
  });

/** STUDIO_DEFAULT_STAGGER_MINUTES clamped to the spec's 15–60 (default 30). */
export function staggerMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.STUDIO_DEFAULT_STAGGER_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STAGGER_MINUTES;
  return Math.min(MAX_STAGGER_MINUTES, Math.max(MIN_STAGGER_MINUTES, Math.round(raw)));
}

export function parseSlots(value: Prisma.JsonValue): DripSlot[] {
  const parsed = z.array(slotSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** 20.14: the stored schedule, or null (none saved yet, or unreadable). */
export function parseSchedule(value: Prisma.JsonValue | null | undefined): PostingSchedule | null {
  if (value === null || value === undefined) return null;
  const parsed = postingScheduleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every slot instant after `fromMs` within the horizon, ascending and de-duplicated. */
export function upcomingSlots(
  slots: DripSlot[],
  fromMs: number,
  horizonDays = DRIP_HORIZON_DAYS,
): number[] {
  return upcomingScheduleSlots(slots, fromMs, horizonDays);
}

type SlotDb = Pick<PrismaClient, 'videoProject' | 'autoPublishOutbox' | 'contentPlanItem'>;

/** 20.9: month-plan item statuses whose post time is still reserved. */
export const PLAN_HOLDING_STATUSES = [
  'QUEUED',
  'GENERATING',
  'READY',
  'SCHEDULED',
  'HELD',
] as const;

/**
 * 20.9: post times reserved by the business's active month plans (content_plan_items.slotAt).
 * They count as held drip slots, so the queue never gives one to another video. projectId is the
 * item's project, or `content-plan:<planId>` before the item is generated.
 */
export async function planHeldSlots(
  db: Pick<PrismaClient, 'contentPlanItem'>,
  scope: { organisationId: string; businessId: string },
  fromMs: number,
): Promise<Array<{ slotAt: Date; projectId: string }>> {
  const items = await db.contentPlanItem.findMany({
    where: {
      organisationId: scope.organisationId,
      slotAt: { gte: new Date(fromMs) },
      status: { in: [...PLAN_HOLDING_STATUSES] },
      plan: { businessId: scope.businessId, status: { in: ['GENERATING', 'SCHEDULED'] } },
    },
    select: { slotAt: true, projectId: true, planId: true },
    orderBy: { slotAt: 'asc' },
  });
  return items.map((i) => ({
    slotAt: i.slotAt,
    projectId: i.projectId ?? `content-plan:${i.planId}`,
  }));
}

/**
 * Drip slots already held by approved videos of this business (outbox rows, target 0) and, 20.9,
 * by its active month plans.
 */
export async function heldSlots(
  db: SlotDb,
  scope: { organisationId: string; businessId: string },
  fromMs: number,
): Promise<Array<{ slotAt: Date; projectId: string }>> {
  const planned = await planHeldSlots(db, scope, fromMs);
  const projects = await db.videoProject.findMany({
    where: { organisationId: scope.organisationId, businessId: scope.businessId, deletedAt: null },
    select: { id: true },
  });
  if (projects.length === 0) return planned;
  const rows = await db.autoPublishOutbox.findMany({
    where: {
      organisationId: scope.organisationId,
      projectId: { in: projects.map((p) => p.id) },
      slotAt: { gte: new Date(fromMs) },
      state: { not: 'FAILED' },
    },
    select: { slotAt: true, projectId: true },
    orderBy: { slotAt: 'asc' },
  });
  const outbox = rows.flatMap((r) =>
    r.slotAt ? [{ slotAt: r.slotAt, projectId: r.projectId }] : [],
  );
  return [...outbox, ...planned].sort((a, b) => a.slotAt.getTime() - b.slotAt.getTime());
}

/** First slot at least DRIP_MIN_LEAD_MS away that no other approved video holds. */
export function firstFreeSlot(slots: DripSlot[], held: Date[], now: number): number | null {
  const taken = new Set(held.map((d) => d.getTime()));
  return upcomingSlots(slots, now + DRIP_MIN_LEAD_MS).find((at) => !taken.has(at)) ?? null;
}

export function publicDripQueue(
  row: {
    slots: Prisma.JsonValue;
    schedule?: Prisma.JsonValue | null;
    platforms: string[];
    enabled: boolean;
    updatedAt: Date;
  },
  held: Array<{ slotAt: Date; projectId: string }>,
  now: number,
) {
  const slots = parseSlots(row.slots);
  const next = row.enabled
    ? firstFreeSlot(
        slots,
        held.map((h) => h.slotAt),
        now,
      )
    : null;
  return {
    slots,
    schedule: parseSchedule(row.schedule),
    platforms: row.platforms,
    enabled: row.enabled,
    staggerMinutes: staggerMinutes(),
    nextSlotAt: next === null ? null : new Date(next).toISOString(),
    queued: held.length,
    upcoming: held.map((h) => ({ slotAt: h.slotAt.toISOString(), projectId: h.projectId })),
    updatedAt: row.updatedAt,
  };
}

/** GET /businesses/:id/drip-queue — null when the business has none. */
export async function getDripQueue(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string },
  now: number,
) {
  const row = await db.dripQueue.findUnique({
    where: {
      organisationId_businessId: {
        organisationId: scope.organisationId,
        businessId: scope.businessId,
      },
    },
  });
  if (!row) return null;
  return publicDripQueue(row, await heldSlots(db, scope, now), now);
}

/** PUT /businesses/:id/drip-queue — create or replace the business's slots. */
export async function putDripQueue(
  db: PrismaClient,
  tenant: Pick<TenantContext, 'organisationId' | 'userId'>,
  businessId: string,
  input: z.output<typeof dripQueueInput>,
  now: number,
) {
  const slots = input.slots as unknown as Prisma.InputJsonValue;
  const schedule = input.schedule as unknown as Prisma.InputJsonValue;
  const row = await db.dripQueue.upsert({
    where: { organisationId_businessId: { organisationId: tenant.organisationId, businessId } },
    create: {
      organisationId: tenant.organisationId,
      businessId,
      slots,
      schedule,
      platforms: input.platforms,
      enabled: input.enabled,
      updatedByUserId: tenant.userId,
    },
    update: {
      slots,
      schedule,
      platforms: input.platforms,
      enabled: input.enabled,
      updatedByUserId: tenant.userId,
    },
  });
  const scope = { organisationId: tenant.organisationId, businessId };
  return publicDripQueue(row, await heldSlots(db, scope, now), now);
}

// ------------------------------------------------------------------ 20.3 month-ahead view

export const upcomingQuery = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * The [from, to) window of GET …/drip-queue/upcoming: default now → now + 31 days, at most
 * MAX_UPCOMING_RANGE_DAYS long; `to` must be after `from`.
 */
export function upcomingWindow(
  query: z.infer<typeof upcomingQuery>,
  now: number,
): { fromMs: number; toMs: number } {
  const fromMs = query.from ? Date.parse(query.from) : now;
  const toMs = query.to ? Date.parse(query.to) : fromMs + DEFAULT_UPCOMING_DAYS * DAY_MS;
  if (!(toMs > fromMs)) throw new ValidationError('to must be after from');
  if (toMs - fromMs > MAX_UPCOMING_RANGE_DAYS * DAY_MS)
    throw new ValidationError(`The window can be at most ${MAX_UPCOMING_RANGE_DAYS} days long`, {
      maxDays: MAX_UPCOMING_RANGE_DAYS,
    });
  return { fromMs, toMs };
}

/**
 * Open slots in [fromMs, toMs): slot instants no approved video holds, that the scheduler could
 * still give to the next video — at least DRIP_MIN_LEAD_MS away and within DRIP_HORIZON_DAYS of
 * now (DECISION: slots beyond the horizon are not shown as open, because no approval can take
 * them yet).
 */
export function openSlotsBetween(
  slots: DripSlot[],
  held: Date[],
  window: { fromMs: number; toMs: number },
  now: number,
): number[] {
  const start = Math.max(window.fromMs, now + DRIP_MIN_LEAD_MS);
  const end = Math.min(window.toMs, now + DRIP_HORIZON_DAYS * DAY_MS);
  if (end <= start) return [];
  const taken = new Set(held.map((d) => d.getTime()));
  // upcomingSlots returns instants strictly after its start; step back 1 ms to keep `start`.
  const days = Math.ceil((end - start) / DAY_MS) + 1;
  return upcomingSlots(slots, start - 1, days).filter((at) => at < end && !taken.has(at));
}

/** GET /businesses/:id/drip-queue/upcoming — the calendar's open-slot markers and summary. */
export async function getUpcomingSlots(
  db: PrismaClient,
  scope: { organisationId: string; businessId: string },
  window: { fromMs: number; toMs: number },
  now: number,
) {
  const [row, held, scheduled, planned] = await Promise.all([
    db.dripQueue.findUnique({ where: { organisationId_businessId: scope } }),
    heldSlots(db, scope, Math.min(window.fromMs, now)),
    db.videoPublication.count({
      where: {
        organisationId: scope.organisationId,
        state: { in: ['SCHEDULED', 'PUBLISHING'] },
        scheduledFor: { gte: new Date(window.fromMs), lt: new Date(window.toMs) },
        project: { businessId: scope.businessId, deletedAt: null },
      },
    }),
    // 20.9: month-plan posts not on the calendar as publications yet (drafting, generating,
    // waiting for review or held); scheduled ones show as their publications.
    db.contentPlanItem.findMany({
      where: {
        organisationId: scope.organisationId,
        slotAt: { gte: new Date(window.fromMs), lt: new Date(window.toMs) },
        status: { in: ['QUEUED', 'GENERATING', 'READY', 'HELD'] },
        plan: { businessId: scope.businessId, status: { in: ['GENERATING', 'SCHEDULED'] } },
      },
      select: { id: true, planId: true, slotAt: true, title: true, kind: true, status: true },
      orderBy: { slotAt: 'asc' },
    }),
  ]);
  const enabled = Boolean(row?.enabled);
  const slots = row ? parseSlots(row.slots) : [];
  const inWindow = held.filter(
    (h) => h.slotAt.getTime() >= window.fromMs && h.slotAt.getTime() < window.toMs,
  );
  const open = enabled
    ? openSlotsBetween(
        slots,
        held.map((h) => h.slotAt),
        window,
        now,
      )
    : [];
  return {
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    configured: row !== null,
    enabled,
    slotsPerWeek: enabled ? slots.length : 0,
    horizonDays: DRIP_HORIZON_DAYS,
    scheduled,
    openSlots: open.map((at) => new Date(at).toISOString()),
    held: inWindow.map((h) => ({ slotAt: h.slotAt.toISOString(), projectId: h.projectId })),
    planned: planned.map((i) => ({
      slotAt: i.slotAt.toISOString(),
      planId: i.planId,
      itemId: i.id,
      title: i.title,
      kind: i.kind,
      status: i.status,
    })),
  };
}

// ------------------------------------------------------------------ 20.3 honest scheduling

/** Why a SCHEDULED project without a start time got no drip slot. */
export type UnscheduledReason = 'queue_off' | 'no_matching_platform' | 'no_free_slot';

/** The reason, from the business's queue and the project's target platforms. */
export function unscheduledReason(
  queue: { enabled: boolean; platforms: string[] } | null,
  targetPlatforms: string[],
): UnscheduledReason {
  if (!queue?.enabled) return 'queue_off';
  const matches =
    queue.platforms.length === 0 || targetPlatforms.some((p) => queue.platforms.includes(p));
  return matches ? 'no_free_slot' : 'no_matching_platform';
}
