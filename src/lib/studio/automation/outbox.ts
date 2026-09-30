import type { AutoPublishOutbox, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ConflictError, NotFoundError, StudioError, ValidationError } from '../../errors';
import { notifySafely, type Notifier } from '../notifications/notifier';
import { projectMetadata } from '../pipeline/project-state';
import {
  DRIP_HORIZON_DAYS,
  firstFreeSlot,
  heldSlots,
  parseSlots,
  staggerMinutes,
  unscheduledReason,
  type UnscheduledReason,
} from '../services/drip-queue';
import { storedTargets, type AutoPublishTarget } from './targets';
import { projectLabel, projectNameParam } from '../../project-name';

// BACKLOG 13.21 — auto-publish outbox. Approval and auto-publish used to be two steps: a process
// dying between them left an APPROVED project with nothing posted. Now the approval transaction
// (automation/approval.ts recordApproval) also writes one studio.auto_publish_outbox row per
// stored target, and the rows are sent by
//   - the approving request itself, right after the commit (automation/auto-publish.ts), and
//   - the dispatcher job (every minute, scripts/worker.ts) for anything left: rows whose retry is
//     due, and rows stuck SENDING (a sender that died) after SENDING_TIMEOUT_MS.
// Each row is claimed with a compare-and-set (PENDING → SENDING), so two senders never send the
// same target. A duplicate-publication conflict means the target is already covered (e.g. the
// sender died after creating the publication): the row is marked SENT with that publication.
// Retryable failures back off 1 min, 5 min, 25 min, 2 h; after MAX_OUTBOX_ATTEMPTS the row is
// FAILED, the creator is notified, and POST /projects/:id/auto-publish/retry re-arms it.
// 15.A5: publishPolicy SCHEDULED uses the same rows. Each target gets an absolute scheduledFor —
// the project's scheduledStartAt, or (none set) the next free slot of the business's drip queue —
// and targets are staggered STUDIO_DEFAULT_STAGGER_MINUTES apart (spec 9.9). The sender creates
// scheduled publications from them (scheduled_publications + a delayed BullMQ job, spec 9.9).

export const MAX_OUTBOX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_BASE_MS = 60_000;
export const OUTBOX_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000;
export const SENDING_TIMEOUT_MS = 10 * 60 * 1000;
export const DISPATCH_BATCH = 100;
export const OUTBOX_DISPATCH_SCHEDULE = '* * * * *';

/** Delay before attempt n+1 after n failed attempts (1-based): 1m, 5m, 25m, 2h (cap). */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 5 ** Math.max(0, attempts - 1), OUTBOX_BACKOFF_CAP_MS);
}

type Tx = Pick<
  Prisma.TransactionClient,
  'videoProject' | 'autoPublishOutbox' | 'dripQueue' | '$executeRaw'
>;

export interface SchedulePlan {
  /** Absolute time per target index (null = publish when sent). */
  times: Array<Date | null>;
  /** Target indexes that are published (drip queues may be limited to some platforms). */
  indexes: number[];
  /** The drip slot taken, if any. */
  slotAt: Date | null;
}

/** 20.3: metadata.scheduleIssue — why an approved SCHEDULED project got no drip slot. */
export interface ScheduleIssue {
  reason: UnscheduledReason;
  horizonDays: number;
  at: string;
}

export type ScheduleDecision =
  { ok: true; plan: SchedulePlan } | { ok: false; reason: UnscheduledReason };

/**
 * 15.A5 — when each target of a SCHEDULED project goes out: from scheduledStartAt (never in the
 * past) or the next free drip slot, target i at +i × stagger. 20.3: when nothing can be
 * scheduled the decision says why (queue off, no drip platform among the targets, or no free
 * slot within DRIP_HORIZON_DAYS) instead of a bare null.
 */
export async function planSchedule(
  tx: Tx,
  project: {
    id: string;
    organisationId: string;
    businessId: string;
    scheduledStartAt: Date | null;
  },
  targets: AutoPublishTarget[],
  now: number,
): Promise<ScheduleDecision> {
  const stagger = staggerMinutes() * 60_000;
  const spread = (base: number, indexes: number[], slotAt: Date | null): ScheduleDecision => ({
    ok: true,
    plan: {
      times: targets.map((_, i) => {
        const position = indexes.indexOf(i);
        return position < 0 ? null : new Date(base + position * stagger);
      }),
      indexes,
      slotAt,
    },
  });
  const all = targets.map((_, i) => i);
  if (project.scheduledStartAt)
    return spread(Math.max(project.scheduledStartAt.getTime(), now), all, null);
  const scope = { organisationId: project.organisationId, businessId: project.businessId };
  const queue = await tx.dripQueue.findUnique({
    where: { organisationId_businessId: scope },
  });
  const platforms = targets.map((t) => t.platform);
  if (!queue?.enabled) return { ok: false, reason: unscheduledReason(queue, platforms) };
  const indexes = all.filter(
    (i) => queue.platforms.length === 0 || queue.platforms.includes(targets[i]?.platform ?? ''),
  );
  if (indexes.length === 0) return { ok: false, reason: unscheduledReason(queue, platforms) };
  // Two approvals of the same business must not take the same slot.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`drip:${project.organisationId}:${project.businessId}`}, 0))`;
  const held = await heldSlots(tx, scope, now);
  const slot = firstFreeSlot(
    parseSlots(queue.slots),
    held.map((h) => h.slotAt),
    now,
  );
  return slot === null
    ? { ok: false, reason: 'no_free_slot' }
    : spread(slot, indexes, new Date(slot));
}

/** 20.3: set (or, with null, clear) metadata.scheduleIssue inside the approval transaction. */
async function recordScheduleIssue(
  tx: Tx,
  projectId: string,
  issue: ScheduleIssue | null,
): Promise<void> {
  if (issue)
    await tx.$executeRaw`
      UPDATE "studio"."video_projects"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify({ scheduleIssue: issue })}::jsonb
      WHERE "id" = ${projectId}`;
  else
    await tx.$executeRaw`
      UPDATE "studio"."video_projects"
      SET "metadata" = "metadata" - 'scheduleIssue'
      WHERE "id" = ${projectId} AND "metadata" IS NOT NULL`;
}

/** 20.3: metadata.scheduleIssue of a project, when there is a readable one. */
export function readScheduleIssue(metadata: Prisma.JsonValue | null): ScheduleIssue | null {
  const issue = projectMetadata(metadata).scheduleIssue as Partial<ScheduleIssue> | undefined;
  if (!issue || typeof issue !== 'object') return null;
  const reasons: UnscheduledReason[] = ['queue_off', 'no_matching_platform', 'no_free_slot'];
  if (!reasons.includes(issue.reason as UnscheduledReason)) return null;
  return {
    reason: issue.reason as UnscheduledReason,
    horizonDays: typeof issue.horizonDays === 'number' ? issue.horizonDays : DRIP_HORIZON_DAYS,
    at: typeof issue.at === 'string' ? issue.at : '',
  };
}

/**
 * Inside the approval transaction: one PENDING row per stored target (AUTO_ON_APPROVAL), or per
 * scheduled target (SCHEDULED, 15.A5). 20.3: a SCHEDULED project that gets no slot records
 * metadata.scheduleIssue (cleared again once it is scheduled) so the Review screen can say so.
 */
export async function writeOutboxRows(
  tx: Tx,
  input: {
    projectId: string;
    organisationId: string;
    approvalTaskId: string;
    planTier: string;
    trigger: 'human' | 'auto';
    now: number;
  },
): Promise<{ count: number; unscheduled: UnscheduledReason | null }> {
  const none = { count: 0, unscheduled: null };
  const project = await tx.videoProject.findUnique({
    where: { id: input.projectId },
    select: {
      id: true,
      organisationId: true,
      businessId: true,
      publishPolicy: true,
      scheduledStartAt: true,
      metadata: true,
    },
  });
  if (project?.publishPolicy !== 'AUTO_ON_APPROVAL' && project?.publishPolicy !== 'SCHEDULED')
    return none;
  const targets = storedTargets(project.metadata);
  if (targets.length === 0) return none;
  let plan: SchedulePlan | null = null;
  if (project.publishPolicy === 'SCHEDULED') {
    const decision = await planSchedule(tx, project, targets, input.now);
    if (!decision.ok) {
      await recordScheduleIssue(tx, project.id, {
        reason: decision.reason,
        horizonDays: DRIP_HORIZON_DAYS,
        at: new Date(input.now).toISOString(),
      });
      return { count: 0, unscheduled: decision.reason };
    }
    plan = decision.plan;
    await recordScheduleIssue(tx, project.id, null);
  }
  const indexes = plan?.indexes ?? targets.map((_, i) => i);
  const result = await tx.autoPublishOutbox.createMany({
    data: indexes.map((index) => ({
      target: targets[index] as unknown as Prisma.InputJsonValue,
      scheduledFor: plan?.times[index] ?? null,
      slotAt: plan?.slotAt && index === indexes[0] ? plan.slotAt : null,
      organisationId: input.organisationId,
      projectId: input.projectId,
      approvalTaskId: input.approvalTaskId,
      targetIndex: index,
      planTier: input.planTier,
      trigger: input.trigger,
      nextAttemptAt: new Date(input.now),
    })),
    skipDuplicates: true,
  });
  return { count: result.count, unscheduled: null };
}

export type SendOutcome =
  | { status: 'sent'; publicationId: string; scheduledFor?: string | null }
  | { status: 'failed'; error: string; retryable: boolean };

/** Sends one target (auto-publish.ts supplies the createPublication call). */
export type TargetSender = (
  row: AutoPublishOutbox,
  target: AutoPublishTarget,
) => Promise<SendOutcome>;

export interface OutboxDeps {
  db: PrismaClient;
  logger: Logger;
  now: () => number;
  /** Absent = built from db/logger/env (notifications/notifier.ts). */
  notifier?: Notifier;
}

/** Retry can help: anything except a request that is wrong in itself. */
export function isRetryableSendError(err: unknown): boolean {
  if (err instanceof ValidationError || err instanceof NotFoundError) return false;
  if (err instanceof StudioError) return err.status >= 409 || err.status === 408;
  return true;
}

/** A duplicate-publication conflict names the publication that already covers the target. */
export function coveringPublicationId(err: unknown): string | undefined {
  if (!(err instanceof ConflictError)) return undefined;
  const id = (err.details as { publicationId?: unknown } | undefined)?.publicationId;
  return typeof id === 'string' ? id : undefined;
}

async function claim(deps: OutboxDeps, row: AutoPublishOutbox): Promise<boolean> {
  const now = new Date(deps.now());
  const claimed = await deps.db.autoPublishOutbox.updateMany({
    where: {
      id: row.id,
      OR: [
        { state: 'PENDING', nextAttemptAt: { lte: now } },
        { state: 'SENDING', lockedAt: { lt: new Date(deps.now() - SENDING_TIMEOUT_MS) } },
      ],
    },
    data: { state: 'SENDING', lockedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count === 1;
}

async function settle(
  deps: OutboxDeps,
  row: AutoPublishOutbox,
  outcome: SendOutcome,
): Promise<AutoPublishOutbox> {
  const attempts = row.attempts + 1;
  if (outcome.status === 'sent') {
    return deps.db.autoPublishOutbox.update({
      where: { id: row.id },
      data: {
        state: 'SENT',
        lockedAt: null,
        publicationId: outcome.publicationId,
        lastError: null,
      },
    });
  }
  const giveUp = !outcome.retryable || attempts >= MAX_OUTBOX_ATTEMPTS;
  const updated = await deps.db.autoPublishOutbox.update({
    where: { id: row.id },
    data: {
      state: giveUp ? 'FAILED' : 'PENDING',
      lockedAt: null,
      lastError: outcome.error.slice(0, 1_000),
      ...(!giveUp && { nextAttemptAt: new Date(deps.now() + outboxBackoffMs(attempts)) }),
    },
  });
  if (giveUp) await notifyGaveUp(deps, updated);
  return updated;
}

async function notifyGaveUp(deps: OutboxDeps, row: AutoPublishOutbox): Promise<void> {
  const project = await deps.db.videoProject.findUnique({
    where: { id: row.projectId },
    select: { name: true, createdByUserId: true },
  });
  if (!project) return;
  const platform = (row.target as { platform?: string } | null)?.platform ?? 'a platform';
  await notifySafely(deps, {
    organisationId: row.organisationId,
    userId: project.createdByUserId,
    kind: 'auto_publish_failed',
    title: `Auto-publishing “${projectLabel(project.name)}” to ${platform} failed`,
    body: `${row.lastError ?? 'Unknown error'} — open the project to retry.`,
    link: `/projects/${row.projectId}`,
    dedupeKey: `auto_publish_failed:${row.id}:${row.attempts}`,
    message: {
      key: 'autoPublishFailed',
      params: {
        name: projectNameParam(project.name),
        platform,
        reason: row.lastError ?? 'Unknown error',
      },
    },
  });
}

/** Send the due rows (optionally of one project). Never throws for a single row. */
export async function dispatchOutbox(
  deps: OutboxDeps,
  send: TargetSender,
  filter: { projectId?: string; limit?: number } = {},
): Promise<AutoPublishOutbox[]> {
  const now = new Date(deps.now());
  const due = await deps.db.autoPublishOutbox.findMany({
    where: {
      ...(filter.projectId && { projectId: filter.projectId }),
      OR: [
        { state: 'PENDING', nextAttemptAt: { lte: now } },
        { state: 'SENDING', lockedAt: { lt: new Date(deps.now() - SENDING_TIMEOUT_MS) } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { targetIndex: 'asc' }],
    take: filter.limit ?? DISPATCH_BATCH,
  });
  const settled: AutoPublishOutbox[] = [];
  for (const row of due) {
    if (!(await claim(deps, row))) continue;
    let outcome: SendOutcome;
    try {
      outcome = await send(row, row.target as unknown as AutoPublishTarget);
    } catch (err) {
      deps.logger.error({ err, outboxId: row.id }, 'auto-publish outbox send failed unexpectedly');
      outcome = { status: 'failed', error: 'Unexpected error while publishing', retryable: true };
    }
    settled.push(await settle(deps, row, outcome));
  }
  return settled;
}

/** The latest approval's rows for a project (what the Review screen shows). */
export async function latestOutbox(
  db: Pick<PrismaClient, 'autoPublishOutbox'>,
  projectId: string,
): Promise<AutoPublishOutbox[]> {
  const latest = await db.autoPublishOutbox.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { approvalTaskId: true },
  });
  if (!latest) return [];
  return db.autoPublishOutbox.findMany({
    where: { projectId, approvalTaskId: latest.approvalTaskId },
    orderBy: { targetIndex: 'asc' },
  });
}

/** Re-arm the FAILED rows of the latest approval (POST /projects/:id/auto-publish/retry). */
export async function requeueFailed(
  deps: Pick<OutboxDeps, 'db' | 'now'>,
  projectId: string,
): Promise<number> {
  const rows = await latestOutbox(deps.db, projectId);
  const failed = rows.filter((r) => r.state === 'FAILED').map((r) => r.id);
  if (failed.length === 0) return 0;
  const result = await deps.db.autoPublishOutbox.updateMany({
    where: { id: { in: failed }, state: 'FAILED' },
    data: { state: 'PENDING', attempts: 0, nextAttemptAt: new Date(deps.now()), lockedAt: null },
  });
  return result.count;
}

/** Public shape for GET /projects/:id/auto-publish. */
export function publicOutboxRow(row: AutoPublishOutbox) {
  const target = row.target as unknown as AutoPublishTarget;
  return {
    id: row.id,
    targetIndex: row.targetIndex,
    target: {
      platform: target.platform,
      account: target.connectionId ?? target.platformAccountId ?? null,
      scheduleOffsetMinutes: target.scheduleOffsetMinutes ?? null,
    },
    scheduledFor: row.scheduledFor,
    slotAt: row.slotAt,
    trigger: row.trigger,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: MAX_OUTBOX_ATTEMPTS,
    nextAttemptAt: row.state === 'PENDING' ? row.nextAttemptAt : null,
    lastError: row.lastError,
    publicationId: row.publicationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function renderIdFor(
  metadata: Prisma.JsonValue | null,
  renders: Array<{ id: string; targetPlatform: string }>,
  platform: string,
): string | undefined {
  const ids = Object.values(
    (projectMetadata(metadata).renders as Record<string, string> | undefined) ?? {},
  );
  return renders.find((r) => ids.includes(r.id) && r.targetPlatform === platform)?.id;
}
