import type { AutoPublishOutbox, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { ConflictError, NotFoundError, StudioError, ValidationError } from '../../errors';
import { notifySafely, type Notifier } from '../notifications/notifier';
import { projectMetadata } from '../pipeline/project-state';
import { storedTargets, type AutoPublishTarget } from './targets';

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

type Tx = Pick<Prisma.TransactionClient, 'videoProject' | 'autoPublishOutbox'>;

/** Inside the approval transaction: one PENDING row per stored target (AUTO_ON_APPROVAL only). */
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
): Promise<number> {
  const project = await tx.videoProject.findUnique({
    where: { id: input.projectId },
    select: { publishPolicy: true, metadata: true },
  });
  if (project?.publishPolicy !== 'AUTO_ON_APPROVAL') return 0;
  const targets = storedTargets(project.metadata);
  if (targets.length === 0) return 0;
  const result = await tx.autoPublishOutbox.createMany({
    data: targets.map((target, index) => ({
      organisationId: input.organisationId,
      projectId: input.projectId,
      approvalTaskId: input.approvalTaskId,
      targetIndex: index,
      target: target as unknown as Prisma.InputJsonValue,
      planTier: input.planTier,
      trigger: input.trigger,
      nextAttemptAt: new Date(input.now),
    })),
    skipDuplicates: true,
  });
  return result.count;
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
    title: `Auto-publishing “${project.name}” to ${platform} failed`,
    body: `${row.lastError ?? 'Unknown error'} — open the project to retry.`,
    link: `/projects/${row.projectId}`,
    dedupeKey: `auto_publish_failed:${row.id}:${row.attempts}`,
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
