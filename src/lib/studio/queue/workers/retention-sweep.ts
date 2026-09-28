import type { PipelineDeps } from '../../pipeline/deps';
import { runRetentionSweep } from '../../services/retention';
import type { RollUpJobData } from '../queues';

// BACKLOG 15.E8 — the daily spec 7.15 retention sweep (04:30 UTC, BullMQ job scheduler in
// scripts/worker.ts), after the 02:15 analytics roll-up and the 03:15 style-memory build.

export const RETENTION_SWEEP_SCHEDULE = '30 4 * * *';

export async function retentionSweep(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const result = await runRetentionSweep({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    audit: deps.audit,
    now: deps.now,
  });
  deps.audit({
    actorUserId: 'system:studio-retention',
    organisationId: 'postmind-platform',
    action: 'studio.retention.sweep',
    resource: { type: 'retention', id: new Date(deps.now()).toISOString().slice(0, 10) },
    metadata: { result },
  });
}

export async function onRetentionSweepFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing is half-deleted: objects go before their rows, so tomorrow's run resumes.
  deps.logger.error({ reason }, 'retention sweep failed');
}
