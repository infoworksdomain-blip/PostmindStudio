import { advanceContentPlans } from '../../services/content-plan-run';
import type { PipelineDeps } from '../../pipeline/deps';
import type { AdvancePlansJobData } from '../queues';

// 20.9 — the month-plan runner. Repeated every minute by the BullMQ job scheduler in
// scripts/worker.ts (and kicked for one plan right after "Generate and schedule"): starts queued
// items within the per-plan concurrency and the daily start limit, holds a plan while its
// organisation is kill-switched or cost-capped, keeps item statuses in step with their projects
// and sends the one summary email once every item is scheduled (content-plan-run.ts).

export async function advanceContentPlansJob(
  data: AdvancePlansJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await advanceContentPlans(
    {
      db: deps.db,
      queue: deps.queue,
      logger: deps.logger,
      now: deps.now,
      killSwitch: deps.killSwitch,
      budget: deps.budget,
      mailer: deps.mailer,
      appUrl: process.env.APP_URL?.trim() || undefined,
    },
    data.planId ? { planId: data.planId } : {},
  );
  if (result.started + result.scheduled + result.completed > 0)
    deps.logger.info(result, 'month plans advanced');
}

export async function onAdvanceContentPlansFailed(
  _data: AdvancePlansJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Plans stay as they are; the next run (a minute later) picks them up.
  deps.logger.error({ reason }, 'month plan runner failed');
}
