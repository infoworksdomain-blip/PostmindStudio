import { ingestLibraryVideo } from '../../library/ingest';
import { markFailed, markFinished, markRunning } from '../../library/ingest-runs';
import type { PipelineDeps } from '../../pipeline/deps';
import type { LibraryIngestJobData } from '../queues';

// BACKLOG 9.1 / 9.3 — one corpus item per job (studio-library queue, low priority when batched).
// Idempotent: the item is keyed by the source's content hash, so a retried job finds it.
// Each attempt is tracked in video_library_ingest_runs for GET /admin/library/ingest/status.

export async function ingestLibraryVideoJob(
  data: LibraryIngestJobData,
  deps: PipelineDeps,
): Promise<void> {
  await markRunning(
    deps.db,
    {
      runId: data.runId,
      sourceUrl: data.item.sourceUrl,
      sourceRef: data.item.sourceRef,
      language: data.item.language,
    },
    new Date(deps.now()),
  );
  const result = await ingestLibraryVideo(deps, data.item, data.planTier);
  await markFinished(deps.db, data.runId, result, new Date(deps.now()));
  deps.logger.info(
    { sourceUrl: data.item.sourceUrl, ...result },
    result.created ? 'library video ingested' : 'library video already ingested',
  );
}

export async function onIngestLibraryVideoFailed(
  data: LibraryIngestJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Failed jobs stay in BullMQ's failed set (dead-letter); the run row records the reason and a
  // resubmission through POST /admin/library/ingest re-enqueues it under a fresh job id.
  deps.logger.error({ sourceUrl: data.item.sourceUrl, reason }, 'library ingestion failed');
  await markFailed(deps.db, data.runId, reason, new Date(deps.now()));
}
