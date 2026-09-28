import { beforeEach, describe, expect, it, vi } from 'vitest';

// BACKLOG 17.2 — JobQueue.jobState tells the lost-publication sweep whether a job id is still
// queued, already ran (and so blocks a re-add with the same id), or is unknown.

const getJob = vi.fn();
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ getJob, add: vi.fn(), close: vi.fn() })),
}));

const { createBullJobQueue, InlineJobQueue } = await import('./enqueue');

const data = {
  publicationId: 'pub',
  projectId: 'prj',
  organisationId: 'org',
  runId: 'run',
  planTier: 'STANDARD' as const,
};

describe('InlineJobQueue.jobState', () => {
  it('is pending while queued, finished once taken, unknown otherwise', async () => {
    const queue = new InlineJobQueue();
    expect(await queue.jobState('publish-video', 'a')).toBeUndefined();
    await queue.add('publish-video', data, { jobId: 'a' });
    expect(await queue.jobState('publish-video', 'a')).toBe('pending');
    queue.take();
    expect(await queue.jobState('publish-video', 'a')).toBe('finished');
  });
});

describe('createBullJobQueue().jobState', () => {
  beforeEach(() => getJob.mockReset());

  it.each([
    ['waiting', 'pending'],
    ['delayed', 'pending'],
    ['active', 'pending'],
    ['prioritized', 'pending'],
    ['waiting-children', 'pending'],
    ['completed', 'finished'],
    ['failed', 'finished'],
    ['unknown', undefined],
  ] as const)('maps BullMQ state %s to %s', async (state, expected) => {
    getJob.mockResolvedValue({ getState: async () => state });
    const queue = createBullJobQueue({});
    expect(await queue.jobState?.('publish-video', 'job-1')).toBe(expected);
    expect(getJob).toHaveBeenCalledWith('job-1');
  });

  it('is unknown when the queue has no such job', async () => {
    getJob.mockResolvedValue(undefined);
    expect(await createBullJobQueue({}).jobState?.('publish-video', 'gone')).toBeUndefined();
  });
});
