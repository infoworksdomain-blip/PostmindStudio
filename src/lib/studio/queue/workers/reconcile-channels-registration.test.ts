import { describe, expect, it } from 'vitest';
import { JOB_QUEUE, QUEUES } from '../queues';
import {
  CHANNEL_RECONCILE_SCHEDULE,
  onReconcileChannelsFailed,
  reconcileChannels,
} from './reconcile-channels';
import { FAILURE_HANDLERS, PROCESSORS } from './runtime';

// BACKLOG 13.35: the reconcile-channels job is wired into the worker runtime.
describe('reconcile-channels registration', () => {
  it('is registered on the analytics queue and scheduled daily at 03:30 UTC', () => {
    expect(JOB_QUEUE['reconcile-channels']).toBe(QUEUES.analytics);
    expect(PROCESSORS['reconcile-channels']).toBe(reconcileChannels);
    expect(FAILURE_HANDLERS['reconcile-channels']).toBe(onReconcileChannelsFailed);
    expect(CHANNEL_RECONCILE_SCHEDULE).toBe('30 3 * * *');
  });
});
