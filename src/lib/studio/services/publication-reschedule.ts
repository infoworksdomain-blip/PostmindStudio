import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { TenantContext } from '../../tenant';
import { currentRunId } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { PublishJobData } from '../queue/queues';
import { MAX_SCHEDULE_AHEAD_MS, MIN_SCHEDULE_LEAD_MS } from '../schedule-window';
import { toPlanTier } from './catalog';

// BACKLOG 13.9 (spec 14.3 "drag to reschedule") — PATCH /publications/:id { scheduledFor }.
//
// The delayed job is replaced atomically: one transaction moves publication.scheduledFor and
// scheduled_publications (scheduledFor, jobId) together, guarded on state SCHEDULED + PENDING, so
// a concurrent fire or cancel either wins (409) or sees the new time. A new delayed job with a
// time-specific id is then enqueued, and the old one is removed when the queue supports it. The
// fire worker is the backstop: every fire job carries the time it was scheduled for and is a
// no-op once the row points elsewhere (fireScheduledPublication), so a stale job never posts.

export const MIN_RESCHEDULE_LEAD_MS = MIN_SCHEDULE_LEAD_MS;
export const MAX_RESCHEDULE_AHEAD_MS = MAX_SCHEDULE_AHEAD_MS;

export const reschedulePublicationInput = z.object({ scheduledFor: z.iso.datetime() }).strict();

/** Job id of the fire job for one scheduled time (a new time gets a new id). */
export function fireJobIdFor(data: PublishJobData, scheduledFor: Date): string {
  return `${jobIds.fireScheduled(data)}__${scheduledFor.getTime()}`;
}

/** Validates the 1 minute – 180 days window (same rule as POST /publications). */
export function assertRescheduleWindow(scheduledFor: Date, now: number): void {
  const lead = scheduledFor.getTime() - now;
  if (!Number.isFinite(lead) || lead < MIN_RESCHEDULE_LEAD_MS || lead > MAX_RESCHEDULE_AHEAD_MS)
    throw new ValidationError('scheduledFor must be between 1 minute and 180 days from now');
}

export async function reschedulePublication(
  deps: { db: PrismaClient; queue: JobQueue; now: () => number },
  tenant: TenantContext,
  id: string,
  input: z.infer<typeof reschedulePublicationInput>,
) {
  const { db } = deps;
  const organisationId = tenant.organisationId;
  const scheduledFor = new Date(input.scheduledFor);
  assertRescheduleWindow(scheduledFor, deps.now());

  const publication = await db.videoPublication.findFirst({
    where: { id, organisationId },
    include: { project: { select: { metadata: true } } },
  });
  if (!publication) throw new NotFoundError('Publication not found');

  const runId = currentRunId(publication.project) ?? 'publish';
  const data: PublishJobData = {
    publicationId: publication.id,
    projectId: publication.projectId,
    organisationId,
    runId,
    planTier: toPlanTier(tenant.organisation.planTier),
    scheduledFor: scheduledFor.toISOString(),
  };
  const jobId = fireJobIdFor(data, scheduledFor);

  const previousJobId = await db.$transaction(async (tx) => {
    const schedule = await tx.scheduledPublication.findUnique({
      where: { publicationId: id },
    });
    const moved = await tx.videoPublication.updateMany({
      where: { id, organisationId, state: 'SCHEDULED', scheduledFor: { not: null } },
      data: { scheduledFor },
    });
    const movedSchedule = await tx.scheduledPublication.updateMany({
      where: { publicationId: id, state: 'PENDING' },
      data: { scheduledFor, jobId },
    });
    if (moved.count === 0 || movedSchedule.count === 0) {
      throw new ConflictError(
        publication.state === 'SCHEDULED'
          ? 'Only publications waiting for their scheduled time can be moved; this one is already being published'
          : `Only scheduled publications can be moved (this one is ${publication.state})`,
      );
    }
    return schedule?.jobId ?? null;
  });

  await deps.queue.add('fire-scheduled-publication', data, {
    jobId,
    delayMs: scheduledFor.getTime() - deps.now(),
  });
  if (previousJobId && previousJobId !== jobId && deps.queue.remove) {
    // Best effort: the fire worker ignores the stale job anyway.
    await deps.queue.remove('fire-scheduled-publication', previousJobId).catch(() => undefined);
  }
  const updated = await db.videoPublication.findFirstOrThrow({ where: { id, organisationId } });
  return {
    publication: updated,
    previousScheduledFor: publication.scheduledFor,
  };
}
