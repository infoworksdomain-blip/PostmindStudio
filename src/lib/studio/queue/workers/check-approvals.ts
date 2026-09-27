import { notifyPendingApprovals } from '../../notifications/events';
import type { PipelineDeps } from '../../pipeline/deps';
import type { RollUpJobData } from '../queues';

// Spec 14.4 "Approval required — notify if pending > 2h". Repeated every 15 minutes by the
// BullMQ job scheduler in scripts/worker.ts; each project run is notified once (dedupeKey).

export const APPROVAL_CHECK_SCHEDULE = '*/15 * * * *';

export async function checkPendingApprovals(
  _data: RollUpJobData,
  deps: PipelineDeps,
): Promise<void> {
  const { notified } = await notifyPendingApprovals(deps);
  if (notified > 0) deps.logger.info({ notified }, 'approval reminders sent');
}

export async function onCheckPendingApprovalsFailed(
  _data: RollUpJobData,
  deps: PipelineDeps,
  reason: string,
): Promise<void> {
  // The next scheduled run tries again; nothing to mark failed.
  deps.logger.error({ reason }, 'approval reminder check failed');
}
