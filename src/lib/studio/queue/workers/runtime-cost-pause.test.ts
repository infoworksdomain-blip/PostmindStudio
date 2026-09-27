import { UnrecoverableError } from 'bullmq';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostCapPausedError } from '../../../errors';
import type { PipelineDeps } from '../../pipeline/deps';
import { JOB_QUEUE, QUEUES } from '../queues';
import {
  APPROVAL_CHECK_SCHEDULE,
  checkPendingApprovals,
  onCheckPendingApprovalsFailed,
} from './check-approvals';
import { describeError, executeJob, FAILURE_HANDLERS, isRetryable, PROCESSORS } from './runtime';

afterEach(() => vi.restoreAllMocks());

const data = { projectId: 'p', organisationId: 'o', runId: 'r', planTier: 'BASIC' as const };

function deps() {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return {
    updateMany,
    deps: {
      db: { videoProject: { updateMany } },
      logger: pino({ level: 'silent' }),
      killSwitch: { assertNotKilled: vi.fn(async () => undefined) },
    } as unknown as PipelineDeps,
  };
}

describe('cost-cap pause in the job runtime (spec 12.5)', () => {
  const paused = new CostCapPausedError('project', 'project reached 90% of its budget');

  it('is not retried and reads as cost_cap_paused', () => {
    expect(isRetryable(paused)).toBe(false);
    expect(describeError(paused)).toBe('cost_cap_paused: project reached 90% of its budget');
  });

  it('fails the run as cost_cap_paused before the step failure handler runs', async () => {
    const { deps: d, updateMany } = deps();
    vi.spyOn(PROCESSORS, 'generate-asset').mockRejectedValue(paused);
    const handler = vi.spyOn(FAILURE_HANDLERS, 'generate-asset').mockResolvedValue();
    await expect(
      executeJob('generate-asset', { ...data, shotId: 's' }, d, {
        attemptsMade: 0,
        maxAttempts: 6,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p' }),
        data: {
          errorReason: 'cost_cap_paused: project reached 90% of its budget',
          state: 'FAILED',
        },
      }),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('still runs the step failure handler if recording the pause fails', async () => {
    const { deps: d, updateMany } = deps();
    updateMany.mockRejectedValue(new Error('db blip'));
    vi.spyOn(PROCESSORS, 'plan-project').mockRejectedValue(paused);
    const handler = vi.spyOn(FAILURE_HANDLERS, 'plan-project').mockResolvedValue();
    await expect(
      executeJob('plan-project', data, d, { attemptsMade: 0, maxAttempts: 6 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('check-pending-approvals job (spec 14.4)', () => {
  it('is registered on the analytics queue with a 15-minute schedule', () => {
    expect(JOB_QUEUE['check-pending-approvals']).toBe(QUEUES.analytics);
    expect(PROCESSORS['check-pending-approvals']).toBe(checkPendingApprovals);
    expect(FAILURE_HANDLERS['check-pending-approvals']).toBe(onCheckPendingApprovalsFailed);
    expect(APPROVAL_CHECK_SCHEDULE).toBe('*/15 * * * *');
  });

  it('notifies each overdue project once through the injected notifier', async () => {
    const notify = vi.fn(async () => ({ created: true }));
    const logger = pino({ level: 'silent' });
    const info = vi.spyOn(logger, 'info');
    const findMany = vi.fn(async () => [
      {
        id: 'p1',
        organisationId: 'o',
        name: 'Launch',
        createdByUserId: 'u',
        metadata: { runId: 'r1' },
        completedAt: new Date(0),
      },
    ]);
    await checkPendingApprovals(
      { organisationId: 'postmind-platform', runId: 'approvals', planTier: 'STANDARD' },
      {
        db: { videoProject: { findMany } },
        logger,
        notifier: { notify, notifyStaff: vi.fn() },
        now: () => 10 * 60 * 60 * 1000,
      } as unknown as PipelineDeps,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: 'READY_FOR_REVIEW',
          completedAt: { lte: new Date(8 * 60 * 60 * 1000), gte: expect.any(Date) },
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: 'o',
        userId: null,
        kind: 'approval_pending',
        dedupeKey: 'approval_pending:p1:r1',
      }),
    );
    expect(info).toHaveBeenCalledWith({ notified: 1 }, 'approval reminders sent');
    const error = vi.spyOn(logger, 'error');
    await onCheckPendingApprovalsFailed(
      { organisationId: 'x', runId: 'r', planTier: 'BASIC' },
      { logger } as unknown as PipelineDeps,
      'boom',
    );
    expect(error).toHaveBeenCalledOnce();
  });
});
