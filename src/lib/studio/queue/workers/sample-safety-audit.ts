import type { PipelineDeps } from '../../pipeline/deps';
import {
  previousPeriod,
  safetyAuditSampleFromEnv,
  sampleSafetyAudit,
} from '../../services/safety-audit';
import type { RollUpJobData } from '../queues';

// BACKLOG 14.11 — monthly Trust & Safety audit sample (SAFETY_AUDIT_SCHEDULE, 06:00 UTC on the
// 1st, BullMQ job scheduler in scripts/worker.ts): draws STUDIO_SAFETY_AUDIT_SAMPLE published
// videos from the month that just ended into the Admin → Safety audit queue. Idempotent, so a
// retry or a manual re-run only tops the sample up.

export async function sampleSafetyAuditJob(
  _data: RollUpJobData,
  deps: PipelineDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const result = await sampleSafetyAudit(deps.db, {
    period: previousPeriod(deps.now()),
    sampleSize: safetyAuditSampleFromEnv(env),
  });
  deps.logger.info({ ...result }, 'safety audit sample drawn');
}

export async function onSampleSafetyAuditFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Staff can draw the sample by hand (POST /api/studio/admin/safety-audit/sample).
  deps.logger.error({ reason }, 'safety audit sampling failed');
}
