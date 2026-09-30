import { describe, expect, it } from 'vitest';
import {
  countStatuses,
  isSafetyFailure,
  isSettled,
  itemStatusFromProject,
  type ProjectSnapshot,
} from './status';

const base: ProjectSnapshot = {
  state: 'QUEUED',
  errorReason: null,
  reviewCode: null,
  safetyReviewPending: false,
  contentSafetyFailed: false,
  publications: [],
  pendingOutbox: 0,
};
const status = (patch: Partial<ProjectSnapshot>) => itemStatusFromProject({ ...base, ...patch });

describe('20.9 plan item status from its project', () => {
  it('follows the pipeline', () => {
    expect(status({ state: 'DRAFT' }).status).toBe('QUEUED');
    expect(status({ state: 'RENDERING' }).status).toBe('GENERATING');
    expect(status({ state: 'READY_FOR_REVIEW', reviewCode: 'quality_not_clean' })).toEqual({
      status: 'READY',
      reason: 'quality_not_clean',
    });
  });

  it('holds anything content safety stopped', () => {
    expect(status({ state: 'READY_FOR_REVIEW', reviewCode: 'content_safety_flag' }).status).toBe(
      'HELD',
    );
    expect(status({ state: 'READY_FOR_REVIEW', contentSafetyFailed: true }).status).toBe('HELD');
    expect(status({ state: 'FAILED', errorReason: 'script_safety_block: no' }).status).toBe('HELD');
    expect(status({ state: 'QUALITY_FAILED', contentSafetyFailed: true }).status).toBe('HELD');
    expect(status({ state: 'QUEUED', safetyReviewPending: true }).status).toBe('HELD');
    expect(isSafetyFailure('content_safety: flagged')).toBe(true);
    expect(isSafetyFailure('provider timeout')).toBe(false);
  });

  it('marks ordinary failures as failed with their reason', () => {
    expect(status({ state: 'FAILED', errorReason: 'cost_cap_paused: x' })).toEqual({
      status: 'FAILED',
      reason: 'cost_cap_paused: x',
    });
    expect(status({ state: 'QUALITY_FAILED' }).status).toBe('FAILED');
  });

  it('is scheduled once approved with a publication or pending auto-publish row', () => {
    expect(status({ state: 'APPROVED', publications: [{ state: 'SCHEDULED' }] }).status).toBe(
      'SCHEDULED',
    );
    expect(status({ state: 'APPROVED', pendingOutbox: 1 }).status).toBe('SCHEDULED');
    expect(status({ state: 'APPROVED', publications: [{ state: 'FAILED' }] })).toEqual({
      status: 'FAILED',
      reason: 'publish_failed',
    });
  });

  it('is posted as soon as one publication is live', () => {
    expect(
      status({
        state: 'PUBLISHING',
        publications: [{ state: 'PUBLISHED' }, { state: 'SCHEDULED' }],
      }).status,
    ).toBe('POSTED');
    expect(status({ state: 'PUBLISHED' }).status).toBe('POSTED');
    expect(status({ state: 'ARCHIVED' }).status).toBe('REMOVED');
  });

  it('counts statuses and knows which are settled', () => {
    const counts = countStatuses(['SCHEDULED', 'SCHEDULED', 'HELD']);
    expect(counts.SCHEDULED).toBe(2);
    expect(counts.HELD).toBe(1);
    expect(counts.POSTED).toBe(0);
    expect(isSettled('QUEUED')).toBe(false);
    expect(isSettled('GENERATING')).toBe(false);
    expect(isSettled('READY')).toBe(true);
    expect(isSettled('SKIPPED')).toBe(true);
  });
});
