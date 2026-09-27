import type { PipelineDeps } from '../../pipeline/deps';
import { resumeCostPausedProjects } from '../../services/auto-resume';
import type { RollUpJobData } from '../queues';

// BACKLOG 13.20 — rollover auto-resume of cost-cap paused projects. Repeated at 00:05 UTC daily
// by the BullMQ job scheduler in scripts/worker.ts (services/auto-resume.ts has the rules).

export async function autoResumePaused(_data: RollUpJobData, deps: PipelineDeps): Promise<void> {
  const result = await resumeCostPausedProjects(deps);
  deps.logger.info(
    { considered: result.considered, resumed: result.resumed, skipped: result.skipped },
    'cost-cap auto-resume complete',
  );
}

export async function onAutoResumePausedFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing to mark failed: paused projects stay paused and the next run tries again.
  deps.logger.error({ reason }, 'cost-cap auto-resume failed');
}
