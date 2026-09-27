import type { PrismaClient, VideoLibraryIngestRun } from '@prisma/client';
import { z } from 'zod';
import type { PlanTier } from '../providers/router';
import { jobIds, type JobQueue } from '../queue/enqueue';
import { ingestItemInput, PLATFORM_ORG } from './ingest';
import { markQueued } from './ingest-runs';

// BACKLOG 13.15 — POST /admin/library/ingest/resubmit: re-enqueue corpus runs from the admin UI
// (before: only the ingest-corpus CLI could). The item submitted with each run is stored on it
// (video_library_ingest_runs.item), so a resubmission uses exactly what was sent.
//   failedOnly (default true): FAILED runs only; false also re-enqueues QUEUED/RUNNING runs whose
//   state has not changed for STUCK_AFTER_MS (a lost job, e.g. Redis flushed).
// Each resubmission gets a fresh job id (BullMQ keeps failed job ids).

export const MAX_RESUBMIT = 500;
export const STUCK_AFTER_MS = 60 * 60 * 1000;

export const resubmitInput = z
  .object({
    runIds: z
      .array(z.string().regex(/^[0-9a-f]{32}$/))
      .min(1)
      .max(MAX_RESUBMIT)
      .optional(),
    failedOnly: z.boolean().default(true),
  })
  .strict();

type Db = Pick<PrismaClient, 'videoLibraryIngestRun' | 'videoLibraryItem'>;

export type ResubmitResult = {
  queued: number;
  skipped: number;
  runs: Array<{ runId: string; action: 'queued' | 'skipped'; reason?: string; jobId?: string }>;
};

function eligible(run: VideoLibraryIngestRun, failedOnly: boolean, now: number): string | null {
  if (run.state === 'FAILED') return null;
  if (run.state === 'SUCCEEDED' || run.state === 'DUPLICATE') return `already ${run.state}`;
  if (failedOnly) return `${run.state}, not FAILED`;
  return now - run.updatedAt.getTime() >= STUCK_AFTER_MS ? null : `${run.state} and not stuck yet`;
}

export async function resubmitIngestRuns(
  deps: { db: Db; queue: JobQueue; now: () => number },
  input: z.infer<typeof resubmitInput>,
  planTier: PlanTier,
): Promise<ResubmitResult> {
  const now = deps.now();
  const runs = await deps.db.videoLibraryIngestRun.findMany({
    where: input.runIds
      ? { runId: { in: input.runIds } }
      : input.failedOnly
        ? { state: 'FAILED' }
        : {
            OR: [
              { state: 'FAILED' },
              {
                state: { in: ['QUEUED', 'RUNNING'] },
                updatedAt: { lte: new Date(now - STUCK_AFTER_MS) },
              },
            ],
          },
    orderBy: { updatedAt: 'asc' },
    take: MAX_RESUBMIT,
  });
  const result: ResubmitResult = { queued: 0, skipped: 0, runs: [] };
  const skip = (runId: string, reason: string) => {
    result.skipped += 1;
    result.runs.push({ runId, action: 'skipped', reason });
  };
  const found = new Set(runs.map((r) => r.runId));
  for (const runId of input.runIds ?? []) if (!found.has(runId)) skip(runId, 'unknown run');
  for (const run of runs) {
    const refusal = eligible(run, input.failedOnly, now);
    if (refusal) {
      skip(run.runId, refusal);
      continue;
    }
    const parsed = ingestItemInput.safeParse(run.item);
    if (!parsed.success) {
      skip(run.runId, 'no stored item (submitted before 13.15): resubmit with the ingest tool');
      continue;
    }
    const item = parsed.data;
    const data = { organisationId: PLATFORM_ORG, runId: run.runId, planTier, batch: true, item };
    const jobId = `${jobIds.ingestLibraryVideo(data)}__resubmit${run.attempts}_${now}`;
    await markQueued(deps.db, {
      runId: run.runId,
      sourceUrl: item.sourceUrl,
      sourceRef: item.sourceRef,
      language: item.language,
      item,
    });
    await deps.queue.add('ingest-library-video', data, { jobId });
    result.queued += 1;
    result.runs.push({ runId: run.runId, action: 'queued', jobId });
  }
  return result;
}
