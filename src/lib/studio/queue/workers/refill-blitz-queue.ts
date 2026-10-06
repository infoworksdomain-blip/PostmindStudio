import { routedPlanGenerator } from '../../services/content-plan-draft';
import { refillBlitzQueue } from '../../services/blitz-refill';
import type { PipelineDeps } from '../../pipeline/deps';
import type { BlitzRefillJobData } from '../queues';

// 22.4 — top a business's Blitz deck up (services/blitz-refill.ts). Runs as the business's
// organisation: the kill switch and billing access are checked at job start (runtime.ts), the
// Claude call goes through the provider router (cost-tracked, budgets and caps apply) and the
// pre-made renders run as low-priority batch jobs. Idempotent: one job id per business per
// debounce window, and the refill only adds what the deck is short of.

export async function refillBlitzQueueJob(
  data: BlitzRefillJobData,
  deps: PipelineDeps,
): Promise<void> {
  await refillBlitzQueue(
    {
      db: deps.db,
      queue: deps.queue,
      logger: deps.logger.child({ correlationId: data.runId }),
      now: deps.now,
      killSwitch: deps.killSwitch,
      generate: routedPlanGenerator(deps, {
        organisationId: data.organisationId,
        planTier: data.planTier,
      }),
    },
    {
      organisationId: data.organisationId,
      businessId: data.businessId,
      userId: data.userId,
      planTier: data.planTier,
    },
  );
}

export async function onRefillBlitzQueueFailed(
  data: BlitzRefillJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing to undo: the next deck view (or swipe) asks for another refill.
  deps.logger.error(
    { organisationId: data.organisationId, businessId: data.businessId, reason },
    'blitz refill failed',
  );
}
