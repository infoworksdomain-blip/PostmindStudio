import { describe, expect, it, vi } from 'vitest';
import type { PipelineDeps } from '../../pipeline/deps';
import { SAFETY_AUDIT_SCHEDULE } from '../../services/safety-audit';
import { JOB_QUEUE, QUEUES } from '../queues';
import { FAILURE_HANDLERS, PROCESSORS } from './runtime';
import { onSampleSafetyAuditFailed, sampleSafetyAuditJob } from './sample-safety-audit';

// BACKLOG 14.11 — the monthly Trust & Safety audit sample is registered like every platform job
// (the sampling itself is covered in test/api/beta-programme.test.ts on a real database).

describe('sample-safety-audit job', () => {
  it('is registered on the analytics queue with its processor and failure handler', () => {
    expect(JOB_QUEUE['sample-safety-audit']).toBe(QUEUES.analytics);
    expect(PROCESSORS['sample-safety-audit']).toBe(sampleSafetyAuditJob);
    expect(FAILURE_HANDLERS['sample-safety-audit']).toBe(onSampleSafetyAuditFailed);
  });

  it('runs at 06:00 UTC on the 1st of each month', () => {
    expect(SAFETY_AUDIT_SCHEDULE).toBe('0 6 1 * *');
  });

  it('logs a final failure (staff can draw the sample by hand)', async () => {
    const error = vi.fn();
    await onSampleSafetyAuditFailed(
      { organisationId: 'postmind-platform', runId: 'safety-audit', planTier: 'STANDARD' },
      { logger: { error } } as unknown as PipelineDeps,
      'boom',
    );
    expect(error).toHaveBeenCalledWith({ reason: 'boom' }, 'safety audit sampling failed');
  });
});
