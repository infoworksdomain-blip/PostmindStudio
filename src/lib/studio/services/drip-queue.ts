import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { TenantContext } from '../../tenant';
import { addDays, isValidTimeZone, wallClock, zonedToUtc } from '../automation/zoned-time';
import { PLATFORMS } from './catalog';

// 15.A5 — per-business drip queue (spec 3.1 "Publish now, schedule to time, drip queue,
// auto-publish"; 9.9 "stagger by 15-60 minutes across platforms by default"). The spec names the
// feature, not its shape; this shape is DERIVED: weekly wall-clock slots in the business's time
// zone. An approved project with publishPolicy SCHEDULED and no scheduledStartAt takes the next
// slot no other approved video of the business holds (automation/outbox.ts writes the rows);
// each of its targets is then staggered STUDIO_DEFAULT_STAGGER_MINUTES apart.

export const MAX_DRIP_SLOTS = 28;
/** How far ahead slots are searched (and createPublication's 180-day cap is far beyond it). */
export const DRIP_HORIZON_DAYS = 8 * 7;
/** A slot closer than this is skipped: the outbox needs time to create the publication. */
export const DRIP_MIN_LEAD_MS = 2 * 60_000;
export const DEFAULT_STAGGER_MINUTES = 30;
export const MIN_STAGGER_MINUTES = 15;
export const MAX_STAGGER_MINUTES = 60;

const slotSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24-hour)'),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, { message: 'timezone must be an IANA time zone' }),
  })
  .strict();

export type DripSlot = z.infer<typeof slotSchema>;

export const dripQueueInput = z
  .object({
    slots: z.array(slotSchema).min(1).max(MAX_DRIP_SLOTS),
    platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

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

/** Every slot instant after `fromMs` within the horizon, ascending and de-duplicated. */
export function upcomingSlots(
  slots: DripSlot[],
  fromMs: number,
  horizonDays = DRIP_HORIZON_DAYS,
): number[] {
  const out = new Set<number>();
  for (const slot of slots) {
    const [hour, minute] = slot.time.split(':').map(Number) as [number, number];
    const today = wallClock(fromMs, slot.timezone);
    for (let d = 0; d <= horizonDays; d += 1) {
      const date = addDays(today, d);
      const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
      if (weekday !== slot.weekday) continue;
      const at = zonedToUtc({ ...date, hour, minute }, slot.timezone);
      if (at > fromMs) out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}

type SlotDb = Pick<PrismaClient, 'videoProject' | 'autoPublishOutbox'>;

/** Drip slots already held by approved videos of this business (outbox rows, target 0). */
export async function heldSlots(
  db: SlotDb,
  scope: { organisationId: string; businessId: string },
  fromMs: number,
): Promise<Array<{ slotAt: Date; projectId: string }>> {
  const projects = await db.videoProject.findMany({
    where: { organisationId: scope.organisationId, businessId: scope.businessId, deletedAt: null },
    select: { id: true },
  });
  if (projects.length === 0) return [];
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
  return rows.flatMap((r) => (r.slotAt ? [{ slotAt: r.slotAt, projectId: r.projectId }] : []));
}

/** First slot at least DRIP_MIN_LEAD_MS away that no other approved video holds. */
export function firstFreeSlot(slots: DripSlot[], held: Date[], now: number): number | null {
  const taken = new Set(held.map((d) => d.getTime()));
  return upcomingSlots(slots, now + DRIP_MIN_LEAD_MS).find((at) => !taken.has(at)) ?? null;
}

export function publicDripQueue(
  row: {
    slots: Prisma.JsonValue;
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
  input: z.infer<typeof dripQueueInput>,
  now: number,
) {
  const slots = input.slots as unknown as Prisma.InputJsonValue;
  const row = await db.dripQueue.upsert({
    where: { organisationId_businessId: { organisationId: tenant.organisationId, businessId } },
    create: {
      organisationId: tenant.organisationId,
      businessId,
      slots,
      platforms: input.platforms,
      enabled: input.enabled,
      updatedByUserId: tenant.userId,
    },
    update: {
      slots,
      platforms: input.platforms,
      enabled: input.enabled,
      updatedByUserId: tenant.userId,
    },
  });
  const scope = { organisationId: tenant.organisationId, businessId };
  return publicDripQueue(row, await heldSlots(db, scope, now), now);
}
