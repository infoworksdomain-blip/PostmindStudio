import { notifierFor } from '../../notifications/notifier';
import type { PipelineDeps } from '../../pipeline/deps';
import { checkPlatformAccounts } from '../../services/account-status';
import type { RollUpJobData } from '../queues';

// BACKLOG 17.3 — the platform account-status check (hourly on studio-analytics, BullMQ job
// scheduler in scripts/worker.ts; each active connection is checked once a day,
// services/account-status.ts). Idempotent: a connection already marked needs_reconnect is not
// checked again, and its owner is notified once per connection lifetime (dedupe key).

export async function checkPlatformAccountsJob(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  await checkPlatformAccounts({
    db: deps.db,
    keys: deps.publishing.keys,
    oauth: deps.publishing.oauth,
    meta: deps.publishing.meta,
    fetchImpl: deps.fetch,
    audit: deps.audit,
    logger: deps.logger,
    now: deps.now,
    sleep: deps.sleep,
    notifier: notifierFor(deps),
  });
}

export async function onCheckPlatformAccountsFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // No connection state is touched on a failed run; the next hourly run continues.
  deps.logger.error({ reason }, 'platform account check failed');
}
