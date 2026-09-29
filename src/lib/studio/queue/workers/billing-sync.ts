import { logger as rootLogger } from '../../../logger';
import type { PipelineDeps } from '../../pipeline/deps';
import { reconcileSubscriptions, sweepStripeEvents } from '../../billing/reconcile';
import { billingJobDepsFromEnv, type BillingJobDeps } from '../../billing/wiring';
import type { RollUpJobData } from '../queues';

// Phase 18 §8 "Webhook loss" — the two scheduled Stripe jobs (analytics queue, platform-level;
// BullMQ job schedulers in scripts/worker.ts):
//   sweep-stripe-events      every 10 minutes: re-process recorded but unprocessed events
//   reconcile-subscriptions  03:15 UTC: store every Stripe subscription again, recompute entitlements
// Both are skipped (logged) while Stripe billing is not configured.

function jobDeps(deps: PipelineDeps): BillingJobDeps | undefined {
  return (
    deps.billingJobs ??
    billingJobDepsFromEnv({ db: deps.db, logger: deps.logger, audit: deps.audit })
  );
}

export async function sweepStripeEventsJob(_data: RollUpJobData, deps: PipelineDeps) {
  const billing = jobDeps(deps);
  if (!billing) {
    deps.logger.debug('stripe event sweep skipped: Stripe billing is not configured');
    return;
  }
  await sweepStripeEvents(billing);
}

export async function reconcileSubscriptionsJob(_data: RollUpJobData, deps: PipelineDeps) {
  const billing = jobDeps(deps);
  if (!billing) {
    deps.logger.info('subscription reconcile skipped: Stripe billing is not configured');
    return;
  }
  await reconcileSubscriptions(billing);
}

export async function onBillingSyncFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // Nothing to mark failed: the next run picks the same work up again.
  (deps.logger ?? rootLogger).error({ reason }, 'stripe billing sync job failed');
}
