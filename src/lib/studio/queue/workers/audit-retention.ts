import type { PipelineDeps } from '../../pipeline/deps';
import { auditRetentionDays, purgeExpiredAuditEntries } from '../../services/audit-retention';
import type { RollUpJobData } from '../queues';

// Phase 18 §2.6 — daily audit-log retention (scheduled in scripts/worker.ts, 02:15 UTC).
// Idempotent; a failed run is retried by BullMQ and again the next day.

export async function auditRetentionJob(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const days = auditRetentionDays(process.env, deps.logger);
  const deleted = await purgeExpiredAuditEntries(deps.db, { now: deps.now(), days });
  deps.logger.info({ deleted, days }, 'audit retention run complete');
}

export async function onAuditRetentionFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  deps.logger.error({ reason }, 'audit retention job failed');
}
