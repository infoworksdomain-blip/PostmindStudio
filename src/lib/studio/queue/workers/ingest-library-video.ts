import { ingestLibraryVideo } from '../../library/ingest';
import type { PipelineDeps } from '../../pipeline/deps';
import type { LibraryIngestJobData } from '../queues';

// BACKLOG 9.1 / 9.3 — one corpus item per job (studio-assets queue, low priority when batched).
// Idempotent: the item is keyed by the source's content hash, so a retried job finds it.

export async function ingestLibraryVideoJob(
  data: LibraryIngestJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await ingestLibraryVideo(deps, data.item, data.planTier);
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
  // Failed jobs stay in BullMQ's failed set (dead-letter) for the admin to re-run.
  deps.logger.error({ sourceUrl: data.item.sourceUrl, reason }, 'library ingestion failed');
}
