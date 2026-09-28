import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { CalendarShadowClient } from '../core/calendar-shadow-client';
import { projectLabel } from '../../project-name';

// BACKLOG 15.W3 — Core calendar shadow entries (spec 16.1). Instead of hooks inside every
// schedule / reschedule / cancel code path (a missed hook would silently lose an entry), the
// shadow is DERIVED from studio.video_publications: every publication that has a scheduledFor gets
// one studio.calendar_shadows row holding the entry Core should show —
//   SCHEDULED / PUBLISHING / PUBLISHED  → upsert at scheduledFor (a reschedule moves it)
//   CANCELLED / FAILED / TAKEN_DOWN     → delete
// A changed desired state re-arms the row (state pending_setup). The sync then pushes armed rows
// through the CalendarShadowClient; until Core ships its calendar API the client is not ready
// and rows stay pending_setup, so nothing is lost.

export const CALENDAR_LOOKBACK_HOURS = 48;
export const CALENDAR_SYNC_BATCH = 200;
export const CALENDAR_MAX_ATTEMPTS = 10;
const HOUR_MS = 60 * 60 * 1000;

const KEEP_STATES = new Set(['SCHEDULED', 'PUBLISHING', 'PUBLISHED']);

type Db = Pick<PrismaClient, 'videoPublication' | 'calendarShadow'>;

export interface CalendarDeriveResult {
  examined: number;
  armed: number;
}

/** Bring calendar_shadows in line with publications changed in the look-back window. */
export async function deriveCalendarShadows(
  db: Db,
  now: number,
  lookbackHours = CALENDAR_LOOKBACK_HOURS,
): Promise<CalendarDeriveResult> {
  const since = new Date(now - lookbackHours * HOUR_MS);
  const pubs = await db.videoPublication.findMany({
    where: { updatedAt: { gte: since }, scheduledFor: { not: null } },
    select: {
      id: true,
      organisationId: true,
      projectId: true,
      platform: true,
      state: true,
      scheduledFor: true,
      project: { select: { name: true } },
    },
  });
  if (pubs.length === 0) return { examined: 0, armed: 0 };
  const existing = new Map(
    (
      await db.calendarShadow.findMany({ where: { publicationId: { in: pubs.map((p) => p.id) } } })
    ).map((s) => [s.publicationId, s]),
  );
  let armed = 0;
  for (const pub of pubs) {
    const desiredOp = KEEP_STATES.has(pub.state) ? 'upsert' : 'delete';
    const row = existing.get(pub.id);
    if (!row && desiredOp === 'delete') continue; // never shown, nothing to remove
    const scheduledFor = desiredOp === 'upsert' ? pub.scheduledFor : null;
    const unchanged =
      row &&
      row.desiredOp === desiredOp &&
      (row.scheduledFor?.getTime() ?? null) === (scheduledFor?.getTime() ?? null) &&
      row.title === projectLabel(pub.project.name);
    if (unchanged) continue;
    const data = {
      organisationId: pub.organisationId,
      projectId: pub.projectId,
      platform: pub.platform,
      desiredOp,
      scheduledFor,
      // 17.9: the calendar is outside Studio's UI; an unnamed project shows the English label.
      title: projectLabel(pub.project.name),
      state: 'pending_setup',
      attempts: 0,
      lastError: null,
    };
    await db.calendarShadow.upsert({
      where: { publicationId: pub.id },
      create: { publicationId: pub.id, ...data },
      update: data,
    });
    armed += 1;
  }
  return { examined: pubs.length, armed };
}

export interface CalendarSyncResult {
  status: 'pending_setup' | 'synced';
  pending: number;
  synced: number;
  failed: number;
}

/** Push armed rows to Core. Never throws for a Core failure: each row records its own. */
export async function syncCalendarShadows(
  deps: { db: Pick<PrismaClient, 'calendarShadow'>; logger: Logger; now: () => number },
  client: CalendarShadowClient,
  appUrl: string,
): Promise<CalendarSyncResult> {
  const where = {
    state: { in: ['pending_setup', 'failed'] },
    attempts: { lt: CALENDAR_MAX_ATTEMPTS },
  };
  if (!client.ready) {
    return {
      status: 'pending_setup',
      pending: await deps.db.calendarShadow.count({ where }),
      synced: 0,
      failed: 0,
    };
  }
  const rows = await deps.db.calendarShadow.findMany({
    where,
    orderBy: { updatedAt: 'asc' },
    take: CALENDAR_SYNC_BATCH,
  });
  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      let coreEntryId = row.coreEntryId;
      if (row.desiredOp === 'upsert' && row.scheduledFor) {
        coreEntryId = (
          await client.upsert({
            publicationId: row.publicationId,
            organisationId: row.organisationId,
            projectId: row.projectId,
            platform: row.platform,
            scheduledFor: row.scheduledFor.toISOString(),
            title: row.title,
            link: `${appUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(row.projectId)}`,
          })
        ).coreEntryId;
      } else {
        await client.remove({
          publicationId: row.publicationId,
          organisationId: row.organisationId,
        });
        coreEntryId = null;
      }
      await deps.db.calendarShadow.update({
        where: { publicationId: row.publicationId },
        data: { state: 'synced', coreEntryId, syncedAt: new Date(deps.now()), lastError: null },
      });
      synced += 1;
    } catch (err) {
      failed += 1;
      deps.logger.warn({ err, publicationId: row.publicationId }, 'calendar shadow sync failed');
      await deps.db.calendarShadow.update({
        where: { publicationId: row.publicationId },
        data: {
          state: 'failed',
          attempts: { increment: 1 },
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        },
      });
    }
  }
  return { status: 'synced', pending: 0, synced, failed };
}
