import { sharedEntitlementsReader } from '../../billing/wiring';
import { routedPlanGenerator } from '../../services/content-plan-draft';
import { advanceAutomations } from '../../services/automation-run';
import { toPlanTier } from '../../services/catalog';
import type { PipelineDeps } from '../../pipeline/deps';
import type { AdvanceAutomationsJobData } from '../queues';

// 22.5 — the automation runner (services/automation-run.ts). Repeated every 5 minutes by the
// BullMQ job scheduler in scripts/worker.ts, and kicked for one automation after a change. Each
// automation's own kill switch is checked by the runner; generation itself happens in the
// month-plan runner and the pipeline jobs, which check it again on start.

export async function advanceAutomationsJob(
  data: AdvanceAutomationsJobData,
  deps: PipelineDeps,
): Promise<void> {
  const result = await advanceAutomations(
    {
      db: deps.db,
      queue: deps.queue,
      logger: deps.logger.child({ correlationId: data.runId }),
      now: deps.now,
      killSwitch: deps.killSwitch,
      generator: (organisationId, planTier) =>
        routedPlanGenerator(deps, { organisationId, planTier: toPlanTier(planTier) }),
      billingAccess: deps.billingAccess,
      // Standalone billing: the same entitlements the API reads (allowance at rollover).
      entitlements: deps.billingAccess ? sharedEntitlementsReader(deps.db) : undefined,
      notifier: deps.notifier,
      audit: deps.audit,
    },
    data.automationId ? { automationId: data.automationId } : {},
  );
  const changed =
    result.activated + result.review + result.rolledOver + result.paused + result.completed;
  if (changed > 0) deps.logger.info(result, 'automations advanced');
}

export async function onAdvanceAutomationsFailed(
  _data: AdvanceAutomationsJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Automations stay as they are; the next run (five minutes later) picks them up.
  deps.logger.error({ reason }, 'automation runner failed');
}
