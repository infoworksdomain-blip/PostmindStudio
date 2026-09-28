import { UpstreamServiceError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { hardDeleteDuePurges } from '../../services/organisation-hard-delete';
import { purgeBucketsFromEnv } from '../../services/purge-storage';
import { sweepAbandonedUploads } from '../../services/upload-sweep';
import type { RollUpJobData } from '../queues';

// BACKLOG 14.1 / 14.2 — daily data-retention jobs, scheduled in scripts/worker.ts:
//   hard-delete-purged-orgs  01:30 UTC  organisations past the purge grace (organisation-hard-delete.ts)
//   sweep-abandoned-uploads  01:45 UTC  PENDING uploads never completed (upload-sweep.ts)
// Both are idempotent; a failed run is retried (BullMQ backoff) and again the next day.

export async function hardDeletePurgedOrgs(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await hardDeleteDuePurges({
    db: deps.db,
    storage: deps.storage,
    now: deps.now,
    logger: deps.logger,
    audit: deps.audit,
    buckets: purgeBucketsFromEnv(),
  });
  deps.logger.info(
    { due: result.due, deleted: result.deleted.length, failed: result.failed.length },
    'organisation hard delete run complete',
  );
  if (result.failed.length) {
    throw new UpstreamServiceError(
      `Hard delete failed for ${result.failed.length} organisation(s)`,
      { failed: result.failed.map((f) => f.organisationId) },
    );
  }
}

export async function sweepAbandonedUploadsJob(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  await sweepAbandonedUploads(deps);
}

export async function onDataRetentionFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing to mark failed: the purge rows keep state hard_deleting / the uploads stay PENDING,
  // and the next daily run tries again.
  deps.logger.error({ reason }, 'data retention job failed');
}
