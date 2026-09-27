import { dispatchAutoPublishOutbox } from '../../automation/auto-publish';
import type { PipelineDeps } from '../../pipeline/deps';
import type { RollUpJobData } from '../queues';

// BACKLOG 13.21 — auto-publish outbox dispatcher. Repeated every minute by the BullMQ job
// scheduler in scripts/worker.ts; sends due rows and re-claims rows whose sender died
// (automation/outbox.ts has the retry and claim rules).

export async function dispatchAutoPublish(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const result = await dispatchAutoPublishOutbox(deps);
  if (result.sent + result.failed + result.retrying > 0)
    deps.logger.info(result, 'auto-publish outbox dispatched');
}

export async function onDispatchAutoPublishFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Rows stay PENDING (or SENDING until the claim times out); the next run picks them up.
  deps.logger.error({ reason }, 'auto-publish outbox dispatch failed');
}
