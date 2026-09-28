import type { PipelineDeps } from '../../pipeline/deps';
import { redriveLostPublications } from '../../services/lost-publications';
import type { RollUpJobData } from '../queues';

// BACKLOG 17.2 — re-enqueue SCHEDULED publications whose publish job was lost (every 10 minutes
// on studio-publish, BullMQ job scheduler in scripts/worker.ts; services/lost-publications.ts).
// Idempotent: deterministic re-drive job ids, and publish-video claims each publication once.

export async function redriveLostPublicationsJob(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  await redriveLostPublications(deps);
}

export async function onRedriveLostPublicationsFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing to mark failed: the publications stay SCHEDULED and the next run finds them again.
  deps.logger.error({ reason }, 'lost publication sweep failed');
}
