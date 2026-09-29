import type { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { AuditEntry } from '../../audit';
import { ConfigurationError } from '../../errors';
import type { KillSwitch } from '../kill-switch';
import { publicationMetadata } from '../platforms/publishing';
import { currentRunId } from '../pipeline/project-state';
import { jobIds, type JobQueue } from '../queue/enqueue';
import type { PublishJobData } from '../queue/queues';
import { toPlanTier } from './catalog';
import { recordedPlanTier } from './redrive';
import { billingHoldOf, type BillingAccessLookup } from '../billing/job-access';

// BACKLOG 17.2 — lost publish jobs (runbooks/review-publish-automation.md). A publication is
// committed first and its job is enqueued after the commit (POST /publications, the auto-publish
// outbox sender, retry). A process that dies in between leaves the publication SCHEDULED with no
// job; so does a fire-scheduled job that marked its schedule FIRED and died before handing over
// to publish-video. This sweep (every 10 minutes, on studio-publish) finds SCHEDULED publications
// whose time passed more than STUDIO_LOST_PUBLISH_MARGIN_MINUTES (default 15) ago — the margin
// covers the gap between the commit and the enqueue, and a queue that is merely busy — and whose
// jobs are not in the queue, and enqueues publish-video once for each.
//
// Never twice:
//   - a job still queued under the id the publication's own path used (fire-scheduled, the
//     publish-video attempt id, or the YouTube quota deferral id) means it is not lost: skipped;
//   - the re-drive job id is deterministic per (publication, attempt, due time), so two sweeps
//     (or two worker processes) add it once, and a re-drive that already ran is not repeated;
//   - publish-video itself claims the row SCHEDULED → PUBLISHING and refuses to upload again
//     after an unknown outcome (uploadStartedAt), so even a duplicate job cannot post twice.
// Kill switches (global, workspace, project, platform) are respected: a halted publication is
// left SCHEDULED and picked up by a later sweep once the switch is released.

export const LOST_PUBLISH_SCHEDULE = '*/10 * * * *';
export const DEFAULT_LOST_PUBLISH_MARGIN_MINUTES = 15;
export const MAX_LOST_PUBLISH_MARGIN_MINUTES = 24 * 60;
const BATCH = 200;
export const REDRIVE_ACTOR = 'system:publish-redrive';

/** STUDIO_LOST_PUBLISH_MARGIN_MINUTES: whole minutes, 5–1440 (default 15). */
export function lostPublishMarginMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STUDIO_LOST_PUBLISH_MARGIN_MINUTES?.trim();
  if (!raw) return DEFAULT_LOST_PUBLISH_MARGIN_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_LOST_PUBLISH_MARGIN_MINUTES) {
    throw new ConfigurationError(
      `STUDIO_LOST_PUBLISH_MARGIN_MINUTES must be a whole number of minutes from 5 to ${MAX_LOST_PUBLISH_MARGIN_MINUTES}`,
    );
  }
  return minutes * 60_000;
}

/** The re-drive's own job id: one per (publication, attempt, due time). */
export function redriveJobId(publicationId: string, retryCount: number, dueAt: Date): string {
  return `publish-video__${publicationId}__redrive__${retryCount}__${dueAt.getTime()}`;
}

export interface LostPublicationDeps {
  db: PrismaClient;
  queue: JobQueue;
  killSwitch: Pick<KillSwitch, 'check'>;
  audit: (entry: AuditEntry) => void;
  logger: Logger;
  now: () => number;
  /** Defaults to STUDIO_LOST_PUBLISH_MARGIN_MINUTES. */
  marginMs?: number;
  /** One organisation only (tests, manual runs); absent = all. */
  organisationId?: string;
  /**
   * Phase 18 §P.3: billing access. A publication of an organisation without full access is left
   * SCHEDULED (held); once access is full again this sweep publishes it.
   */
  billingAccess?: BillingAccessLookup;
}

export interface LostPublicationResult {
  considered: number;
  redriven: string[];
  skipped: Array<{ id: string; reason: string }>;
}

type Candidate = Prisma.VideoPublicationGetPayload<{
  include: { project: { select: { metadata: true; deletedAt: true } } };
}>;

type Schedule = { scheduledFor: Date; state: string; jobId: string | null } | undefined;

async function queued(
  queue: JobQueue,
  name: 'publish-video' | 'fire-scheduled-publication',
  id: string,
) {
  return (await queue.jobState?.(name, id)) ?? undefined;
}

/** The publish-video id the publication's own path used for its current attempt. */
function expectedPublishJobId(publication: Candidate, data: PublishJobData): string {
  const deferredUntil = publicationMetadata(publication).quotaDeferredUntil;
  if (
    typeof deferredUntil === 'string' &&
    publication.scheduledFor &&
    Date.parse(deferredUntil) === publication.scheduledFor.getTime()
  )
    return `publish-video__${publication.id}__quota__${publication.scheduledFor.getTime()}`;
  return jobIds.publishVideo(data, publication.retryCount);
}

async function redriveOne(
  deps: LostPublicationDeps,
  publication: Candidate,
  schedule: Schedule,
  cutoff: Date,
): Promise<string | undefined> {
  if (publication.project.deletedAt) return 'project deleted';
  // An upload that started and never recorded its outcome may be live: a person checks.
  if (publicationMetadata(publication).uploadStartedAt)
    return 'upload outcome unknown; check the platform first';
  const status = await deps.killSwitch.check({
    organisationId: publication.organisationId,
    projectId: publication.projectId,
    platform: publication.platform,
  });
  if (status.killed) return `kill_switch_engaged: ${status.level}`;
  if (deps.billingAccess && (await deps.billingAccess(publication.organisationId)) !== 'full')
    return 'billing hold: waiting for payment';
  if (schedule?.state === 'CANCELLED') return 'schedule cancelled';

  const data: PublishJobData = {
    projectId: publication.projectId,
    organisationId: publication.organisationId,
    runId: currentRunId(publication.project) ?? 'publish',
    planTier: recordedPlanTier(publication.project) ?? toPlanTier(undefined),
    publicationId: publication.id,
  };
  if (schedule?.state === 'PENDING') {
    if (schedule.scheduledFor >= cutoff) return 'schedule not due yet';
    const fireId = schedule.jobId ?? jobIds.fireScheduled(data);
    if ((await queued(deps.queue, 'fire-scheduled-publication', fireId)) === 'pending')
      return 'fire-scheduled job still queued';
  }
  if (
    (await queued(deps.queue, 'publish-video', expectedPublishJobId(publication, data))) ===
    'pending'
  )
    return 'publish job still queued';
  const dueAt = publication.scheduledFor ?? publication.createdAt;
  // A publication released from a billing hold gets its own id, so an earlier re-drive does not
  // block it ("already re-driven once").
  const heldAt = billingHoldOf(publication.metadata);
  const jobId = heldAt
    ? `${redriveJobId(publication.id, publication.retryCount, dueAt)}__billing__${Date.parse(heldAt)}`
    : redriveJobId(publication.id, publication.retryCount, dueAt);
  const earlier = await queued(deps.queue, 'publish-video', jobId);
  if (earlier === 'pending') return 're-drive already queued';
  if (earlier === 'finished') return 'already re-driven once; check it by hand';

  if (schedule?.state === 'PENDING') {
    // Consume the schedule so a fire job that turns up after all becomes a no-op.
    const fired = await deps.db.scheduledPublication.updateMany({
      where: {
        publicationId: publication.id,
        state: 'PENDING',
        scheduledFor: schedule.scheduledFor,
      },
      data: { state: 'FIRED' },
    });
    if (fired.count === 0) return 'schedule changed concurrently';
  }
  await deps.queue.add('publish-video', data, { jobId });
  deps.audit({
    actorUserId: REDRIVE_ACTOR,
    organisationId: publication.organisationId,
    action: 'studio.publication.lost_job_redriven',
    resource: { type: 'video_publication', id: publication.id },
    metadata: {
      platform: publication.platform,
      dueAt: dueAt.toISOString(),
      jobId,
      schedule: schedule?.state ?? null,
    },
  });
  deps.logger.warn(
    {
      publicationId: publication.id,
      organisationId: publication.organisationId,
      platform: publication.platform,
      dueAt: dueAt.toISOString(),
      jobId,
    },
    'lost publish job re-driven',
  );
  return undefined;
}

export async function redriveLostPublications(
  deps: LostPublicationDeps,
): Promise<LostPublicationResult> {
  const cutoff = new Date(deps.now() - (deps.marginMs ?? lostPublishMarginMs()));
  const candidates = await deps.db.videoPublication.findMany({
    where: {
      ...(deps.organisationId && { organisationId: deps.organisationId }),
      state: 'SCHEDULED',
      // Untouched for the margin too: a retry or reschedule that just happened is still enqueuing.
      updatedAt: { lt: cutoff },
      OR: [{ scheduledFor: { lt: cutoff } }, { scheduledFor: null, createdAt: { lt: cutoff } }],
    },
    include: { project: { select: { metadata: true, deletedAt: true } } },
    orderBy: { updatedAt: 'asc' },
    take: BATCH,
  });
  const schedules = new Map(
    (
      await deps.db.scheduledPublication.findMany({
        where: { publicationId: { in: candidates.map((c) => c.id) } },
      })
    ).map((s) => [s.publicationId, s]),
  );
  const result: LostPublicationResult = {
    considered: candidates.length,
    redriven: [],
    skipped: [],
  };
  for (const publication of candidates) {
    const skippedReason = await redriveOne(
      deps,
      publication,
      schedules.get(publication.id),
      cutoff,
    );
    if (skippedReason) result.skipped.push({ id: publication.id, reason: skippedReason });
    else result.redriven.push(publication.id);
  }
  if (result.redriven.length || result.skipped.length)
    deps.logger.info(
      {
        considered: result.considered,
        redriven: result.redriven.length,
        skipped: result.skipped.length,
      },
      'lost publication sweep finished',
    );
  return result;
}
