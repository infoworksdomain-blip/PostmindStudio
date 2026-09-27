import type { LibraryIngestState, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

// Corpus ingestion tracking (BACKLOG 9.2/9.3): one video_library_ingest_runs row per source,
// keyed by the ingest job's runId (hash of the source URL). The admin ingest endpoint writes
// QUEUED, the worker RUNNING → SUCCEEDED | DUPLICATE, its final-failure handler FAILED. The
// status endpoint and scripts/ops/ingest-corpus.ts read it to monitor a 50k run.

type Db = Pick<PrismaClient, 'videoLibraryIngestRun' | 'videoLibraryItem'>;

export const INGEST_STATES: readonly LibraryIngestState[] = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'DUPLICATE',
  'FAILED',
];
const DONE: ReadonlySet<LibraryIngestState> = new Set(['SUCCEEDED', 'DUPLICATE']);
const REASON_MAX = 1_000;

export interface RunIdentity {
  runId: string;
  sourceUrl: string;
  sourceRef?: string;
  language?: string;
  /** 13.15: the submitted item, kept so a failure can be resubmitted from the admin UI. */
  item?: Prisma.InputJsonValue;
}

export type SubmitDecision =
  | { action: 'enqueue'; jobSuffix: string }
  | { action: 'skip'; state: LibraryIngestState; libraryItemId: string | null };

/**
 * What to do with a submitted source given its existing run (if any): already ingested →
 * skip; failed → re-enqueue under a fresh job id (BullMQ keeps failed job ids, so the same id
 * would be ignored); queued/running or new → enqueue with the stable id (deduplicated).
 */
export function submitDecision(
  existing: { state: LibraryIngestState; attempts: number; libraryItemId: string | null } | null,
): SubmitDecision {
  if (!existing) return { action: 'enqueue', jobSuffix: '' };
  if (DONE.has(existing.state))
    return { action: 'skip', state: existing.state, libraryItemId: existing.libraryItemId };
  if (existing.state === 'FAILED')
    return { action: 'enqueue', jobSuffix: `__retry${existing.attempts}` };
  return { action: 'enqueue', jobSuffix: '' };
}

/** Existing runs for a batch of runIds, keyed by runId. */
export async function existingRuns(db: Db, runIds: string[]) {
  const rows = await db.videoLibraryIngestRun.findMany({
    where: { runId: { in: runIds } },
    select: { runId: true, state: true, attempts: true, libraryItemId: true },
  });
  return new Map(rows.map((r) => [r.runId, r]));
}

export async function markQueued(db: Db, run: RunIdentity): Promise<void> {
  const tracking = {
    sourceUrl: run.sourceUrl,
    sourceRef: run.sourceRef ?? null,
    language: run.language ?? null,
    ...(run.item !== undefined && { item: run.item }),
  };
  await db.videoLibraryIngestRun.upsert({
    where: { runId: run.runId },
    create: { runId: run.runId, ...tracking },
    update: { ...tracking, state: 'QUEUED', errorReason: null, finishedAt: null },
  });
}

export async function markRunning(db: Db, run: RunIdentity, now: Date): Promise<void> {
  await db.videoLibraryIngestRun.upsert({
    where: { runId: run.runId },
    create: {
      runId: run.runId,
      sourceUrl: run.sourceUrl,
      sourceRef: run.sourceRef ?? null,
      language: run.language ?? null,
      state: 'RUNNING',
      attempts: 1,
      startedAt: now,
    },
    update: { state: 'RUNNING', attempts: { increment: 1 }, startedAt: now },
  });
}

export async function markFinished(
  db: Db,
  runId: string,
  result: { libraryItemId: string; created: boolean },
  now: Date,
): Promise<void> {
  await db.videoLibraryIngestRun.updateMany({
    where: { runId },
    data: {
      state: result.created ? 'SUCCEEDED' : 'DUPLICATE',
      libraryItemId: result.libraryItemId,
      errorReason: null,
      finishedAt: now,
    },
  });
}

export async function markFailed(db: Db, runId: string, reason: string, now: Date): Promise<void> {
  await db.videoLibraryIngestRun.updateMany({
    where: { runId },
    data: { state: 'FAILED', errorReason: reason.slice(0, REASON_MAX), finishedAt: now },
  });
}

export const ingestStatusQuery = z.object({
  /** Counts cover runs whose state changed in the last N hours. */
  windowHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  failures: z.coerce.number().int().min(0).max(100).default(20),
  /** Comma-separated runIds (≤ 100): per-run state for the ingest-corpus review report. */
  runIds: z
    .string()
    .max(100 * 65)
    .transform((s) =>
      s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .refine((ids) => ids.length <= 100 && ids.every((id) => /^[a-f0-9]{8,64}$/.test(id)), {
      message: 'runIds must be at most 100 hex run ids',
    })
    .optional(),
});
export type IngestStatusQuery = z.infer<typeof ingestStatusQuery>;

export async function ingestStatus(db: Db, query: IngestStatusQuery, now: number) {
  const since = new Date(now - query.windowHours * 3_600_000);
  const [windowed, open, failures, liveItems, runs] = await Promise.all([
    db.videoLibraryIngestRun.groupBy({
      by: ['state'],
      where: { updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.videoLibraryIngestRun.groupBy({
      by: ['state'],
      where: { state: { in: ['QUEUED', 'RUNNING'] } },
      _count: { _all: true },
    }),
    query.failures > 0
      ? db.videoLibraryIngestRun.findMany({
          where: { state: 'FAILED', updatedAt: { gte: since } },
          orderBy: { updatedAt: 'desc' },
          take: query.failures,
          select: {
            runId: true,
            sourceUrl: true,
            sourceRef: true,
            errorReason: true,
            attempts: true,
            finishedAt: true,
          },
        })
      : Promise.resolve([]),
    db.videoLibraryItem.count({ where: { retiredAt: null } }),
    query.runIds?.length
      ? db.videoLibraryIngestRun.findMany({
          where: { runId: { in: query.runIds } },
          select: {
            runId: true,
            sourceRef: true,
            state: true,
            libraryItemId: true,
            errorReason: true,
          },
        })
      : Promise.resolve(undefined),
  ]);
  const counts = Object.fromEntries(INGEST_STATES.map((s) => [s, 0])) as Record<
    LibraryIngestState,
    number
  >;
  for (const row of windowed) counts[row.state] = row._count._all;
  const openCount = (state: LibraryIngestState) =>
    open.find((r) => r.state === state)?._count._all ?? 0;
  const completed = counts.SUCCEEDED + counts.DUPLICATE;
  return {
    windowHours: query.windowHours,
    since: since.toISOString(),
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    /** Completed (ingested or duplicate) per hour over the window. */
    completedPerHour: Math.round((completed / query.windowHours) * 10) / 10,
    backlog: { queued: openCount('QUEUED'), running: openCount('RUNNING') },
    liveLibraryItems: liveItems,
    recentFailures: failures.map((f) => ({
      ...f,
      finishedAt: f.finishedAt?.toISOString() ?? null,
    })),
    ...(runs && { runs }),
  };
}
