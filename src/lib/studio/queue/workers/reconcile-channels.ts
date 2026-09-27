import { NotImplementedError } from '../../../errors';
import { pendingCoreChannelDirectory } from '../../core/channel-directory';
import type { PipelineDeps } from '../../pipeline/deps';
import { reconcileMetaChannels } from '../../services/channel-reconciliation';
import type { RollUpJobData } from '../queues';

// BACKLOG 13.35 — daily Core ↔ Studio Meta channel reconciliation (03:30 UTC, BullMQ job
// scheduler in scripts/worker.ts). Until Core ships list-channels the run is skipped with an info
// log: a job that fails every day would only train on-call to ignore it.

export const CHANNEL_RECONCILE_SCHEDULE = '30 3 * * *';

export async function reconcileChannels(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  try {
    const report = await reconcileMetaChannels(
      {
        db: deps.db,
        directory: deps.coreChannels ?? pendingCoreChannelDirectory,
        logger: deps.logger,
        audit: deps.audit,
        now: deps.now,
      },
      { apply: true },
    );
    deps.logger.info(
      { totals: report.totals, errors: report.errors.length },
      'channel reconciliation finished',
    );
  } catch (err) {
    if (err instanceof NotImplementedError) {
      deps.logger.info({ reason: err.message }, 'channel reconciliation skipped');
      return;
    }
    throw err;
  }
}

export async function onReconcileChannelsFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // The next daily run tries again; nothing to mark failed.
  deps.logger.error({ reason }, 'channel reconciliation failed');
}
