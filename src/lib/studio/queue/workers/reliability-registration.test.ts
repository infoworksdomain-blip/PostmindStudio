import { describe, expect, it } from 'vitest';
import { ACCOUNT_CHECK_SCHEDULE } from '../../services/account-status';
import { LOST_PUBLISH_SCHEDULE } from '../../services/lost-publications';
import { UPLOAD_SWEEP_SCHEDULE } from '../../services/upload-sweep';
import { JOB_QUEUE, QUEUES } from '../queues';
import { checkPlatformAccountsJob, onCheckPlatformAccountsFailed } from './check-platform-accounts';
import { onDataRetentionFailed, sweepAbandonedUploadsJob } from './data-retention';
import {
  onRedriveLostPublicationsFailed,
  redriveLostPublicationsJob,
} from './redrive-lost-publications';
import { FAILURE_HANDLERS, PROCESSORS } from './runtime';

// BACKLOG 17.1–17.3: the reliability jobs are wired into the worker runtime and scheduled
// (scripts/worker.ts upserts one BullMQ job scheduler each).
describe('reliability job registration', () => {
  it('sweeps abandoned uploads daily at 01:45 UTC on studio-orchestration', () => {
    expect(JOB_QUEUE['sweep-abandoned-uploads']).toBe(QUEUES.orchestration);
    expect(PROCESSORS['sweep-abandoned-uploads']).toBe(sweepAbandonedUploadsJob);
    expect(FAILURE_HANDLERS['sweep-abandoned-uploads']).toBe(onDataRetentionFailed);
    expect(UPLOAD_SWEEP_SCHEDULE).toBe('45 1 * * *');
  });

  it('re-drives lost publish jobs every 10 minutes on studio-publish', () => {
    expect(JOB_QUEUE['redrive-lost-publications']).toBe(QUEUES.publish);
    expect(PROCESSORS['redrive-lost-publications']).toBe(redriveLostPublicationsJob);
    expect(FAILURE_HANDLERS['redrive-lost-publications']).toBe(onRedriveLostPublicationsFailed);
    expect(LOST_PUBLISH_SCHEDULE).toBe('*/10 * * * *');
  });

  it('checks platform accounts hourly on studio-analytics', () => {
    expect(JOB_QUEUE['check-platform-accounts']).toBe(QUEUES.analytics);
    expect(PROCESSORS['check-platform-accounts']).toBe(checkPlatformAccountsJob);
    expect(FAILURE_HANDLERS['check-platform-accounts']).toBe(onCheckPlatformAccountsFailed);
    expect(ACCOUNT_CHECK_SCHEDULE).toBe('20 * * * *');
  });
});
