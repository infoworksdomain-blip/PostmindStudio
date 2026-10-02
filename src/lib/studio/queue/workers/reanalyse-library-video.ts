import { reanalyseLibraryVideo } from '../../library/reanalyse';
import type { PipelineDeps } from '../../pipeline/deps';
import type { LibraryReanalyseJobData } from '../queues';

// BACKLOG 15.D7 / Addendum A3.8 — re-run analysis + embedding on one stored corpus item
// (studio-library queue, low priority: staff curation). Idempotent: the analysis row is upserted
// and the embedding replaced, so a retried job converges on the same state.

export async function reanalyseLibraryVideoJob(
  data: LibraryReanalyseJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await reanalyseLibraryVideo(deps, data.libraryItemId, data.planTier);
  // 20.15: analysis, description, category and embedding changed: cached reads must see it.
  await deps.libraryCache?.bump('reanalyse');
  deps.logger.info(result, 'library video re-analysed');
}

export async function onReanalyseLibraryVideoFailed(
  data: LibraryReanalyseJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // The item keeps its previous analysis and embedding; the failed job stays in BullMQ's failed
  // set (dead-letter panel) and reanalysedAt is unchanged, so the admin list shows it as stale.
  deps.logger.error(
    { libraryItemId: data.libraryItemId, reason },
    'library video re-analysis failed',
  );
}
