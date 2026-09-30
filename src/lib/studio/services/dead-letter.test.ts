import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError, UpstreamServiceError, ValidationError } from '../../errors';
import { InlineJobQueue } from '../queue/enqueue';
import type { JobDataMap } from '../queue/queues';
import { QUEUES } from '../queue/queues';
import {
  decodeCursor,
  drainFailed,
  encodeCursor,
  findQueue,
  inlineDeadLetterQueues,
  listFailed,
  REDACTED,
  redactJobData,
  redactText,
  requeueFailed,
  retryAdvisory,
  retryFailed,
  toView,
  type DeadLetterQueue,
} from './dead-letter';

// BACKLOG 15.D4 — dead-letter service: redaction, paging, retry / requeue / drain on the inline
// queue (the same port BullMQ implements in production).

const base = { organisationId: 'org_1', runId: 'run_1', planTier: 'STANDARD' as const };
const publishJob: JobDataMap['publish-video'] = {
  ...base,
  projectId: 'prj_1',
  publicationId: 'pub_1',
};
const scanJob: JobDataMap['scan-website'] = { ...base, businessId: 'biz_1', scanId: 'scan_1' };

function queueWithFailures(n = 3) {
  const inline = new InlineJobQueue();
  for (let i = 0; i < n; i += 1) {
    inline.fail(
      { name: 'publish-video', data: { ...publishJob, publicationId: `pub_${i}` }, jobId: `p${i}` },
      `tiktok/rate_limited: slow down ${i}`,
      6,
      1_000 + i,
    );
  }
  inline.fail({ name: 'scan-website', data: scanJob, jobId: 'scan' }, 'boom', 6, 5_000);
  return { inline, queues: inlineDeadLetterQueues(inline) };
}

const noDb = {} as PrismaClient;

describe('redaction', () => {
  it('replaces values under sensitive keys and strips URL query strings', () => {
    const out = redactJobData({
      accessToken: 'abc',
      nested: { apiKey: 'k', password: 'p', keep: 'ok' },
      item: { sourceUrl: 'https://cdn.example/v.mp4?X-Amz-Signature=deadbeef&token=t#frag' },
      tags: ['https://u:pw@host.example/a?b=c'],
      count: 3,
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe(REDACTED);
    expect(out.nested).toEqual({ apiKey: REDACTED, password: REDACTED, keep: 'ok' });
    expect((out.item as { sourceUrl: string }).sourceUrl).toBe(
      'https://cdn.example/v.mp4?X-Amz-Signature=redacted&token=redacted',
    );
    expect(out.tags).toEqual(['https://host.example/a?b=redacted']);
    expect(out.count).toBe(3);
  });

  it('scrubs bearer tokens and key=value secrets from free text', () => {
    const text = redactText('401 Bearer sk-live-123 while api_key=xyz and token: "t0k"');
    expect(text).not.toMatch(/sk-live-123|xyz|t0k/);
    expect(text).toContain(`Bearer ${REDACTED}`);
  });

  it('builds the view: redacted data, first frames, org and project ids, override flag', () => {
    const view = toView({
      id: 'j1',
      name: 'generate-asset',
      data: { ...base, projectId: 'prj_1', shotId: 's1', secret: 'x' },
      failedReason: 'runway/timeout: https://x.example/?sig=1',
      stacktrace: ['a', 'b', 'c', 'd'],
      attemptsMade: 6,
      timestamp: 0,
      processedOn: null,
      finishedOn: 1_000,
    });
    expect(view).toMatchObject({
      organisationId: 'org_1',
      projectId: 'prj_1',
      providerOverride: true,
      failedAt: new Date(1_000).toISOString(),
      processedAt: null,
      failedReason: 'runway/timeout: https://x.example/?sig=redacted',
    });
    expect(view.stacktrace).toHaveLength(3);
    expect((view.data as { secret: string }).secret).toBe(REDACTED);
  });
});

describe('cursor', () => {
  it('round-trips offsets and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor(undefined)).toBe(0);
    expect(() => decodeCursor('bm9wZQ')).toThrow(ValidationError);
  });
});

describe('findQueue', () => {
  it('404s an unknown queue name', () => {
    const { queues } = queueWithFailures(0);
    expect(findQueue(queues, QUEUES.publish).name).toBe(QUEUES.publish);
    expect(() => findQueue(queues, 'studio-nope')).toThrow(NotFoundError);
  });
});

describe('listFailed', () => {
  it('pages newest first per queue with a cursor', async () => {
    const { queues } = queueWithFailures(3);
    const publish = findQueue(queues, QUEUES.publish);
    const first = await listFailed(publish, { limit: 2 });
    expect(first.total).toBe(3);
    expect(first.jobs.map((j) => j.id)).toEqual(['p2', 'p1']);
    expect(first.nextCursor).not.toBeNull();
    const second = await listFailed(publish, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.jobs.map((j) => j.id)).toEqual(['p0']);
    expect(second.nextCursor).toBeNull();
    // Other queues' failures are not mixed in.
    const assets = await listFailed(findQueue(queues, QUEUES.assets), { limit: 25 });
    expect(assets.jobs.map((j) => j.name)).toEqual(['scan-website']);
  });

  it('502s when the queue does not answer in time', async () => {
    const hanging: DeadLetterQueue = {
      ...findQueue(queueWithFailures(0).queues, QUEUES.publish),
      countFailed: () => new Promise(() => undefined),
    };
    await expect(listFailed(hanging, { limit: 1 }, 10)).rejects.toThrow(UpstreamServiceError);
  });

  it('502s with the reason when Redis rejects (connection refused, server too old)', async () => {
    const broken: DeadLetterQueue = {
      ...findQueue(queueWithFailures(0).queues, QUEUES.publish),
      countFailed: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    };
    await expect(listFailed(broken, { limit: 1 })).rejects.toThrow(
      new UpstreamServiceError(
        'Dead-letter queue unavailable: Redis error (connect ECONNREFUSED 127.0.0.1:6379)',
      ),
    );
  });
});

describe('retry / requeue / drain', () => {
  it('retries a failed job back onto the pending list', async () => {
    const { inline, queues } = queueWithFailures(1);
    const result = await retryFailed(
      { db: noDb, jobs: inline },
      findQueue(queues, QUEUES.publish),
      'p0',
    );
    expect(result).toEqual({
      job: { id: 'p0', name: 'publish-video', state: 'waiting' },
      advisory: null,
    });
    expect(inline.pending.map((j) => j.jobId)).toEqual(['p0']);
    expect(inline.failed.map((j) => j.id)).toEqual(['scan']);
  });

  it('404s a job that is not in the failed set', async () => {
    const { inline, queues } = queueWithFailures(1);
    await expect(
      retryFailed({ db: noDb, jobs: inline }, findQueue(queues, QUEUES.publish), 'missing'),
    ).rejects.toThrow(NotFoundError);
  });

  it('requeues a non-asset job unchanged and refuses a provider override for it', async () => {
    const { inline, queues } = queueWithFailures(1);
    const assets = findQueue(queues, QUEUES.assets);
    await expect(
      requeueFailed({ db: noDb, jobs: inline }, assets, 'scan', { providerId: 'luma' }),
    ).rejects.toThrow(/generate-asset jobs only/);
    const result = await requeueFailed({ db: noDb, jobs: inline }, assets, 'scan', {});
    expect(result).toEqual({
      job: { id: 'scan', name: 'scan-website' },
      outcome: { action: 'requeued' },
    });
    expect(inline.pending.map((j) => j.name)).toEqual(['scan-website']);
  });

  it('drains only with the exact queue name typed', async () => {
    const { inline, queues } = queueWithFailures(3);
    const publish = findQueue(queues, QUEUES.publish);
    await expect(drainFailed(publish, { confirm: 'studio-publis', reason: 'old' })).rejects.toThrow(
      ValidationError,
    );
    expect(await drainFailed(publish, { confirm: QUEUES.publish, reason: 'old noise' })).toEqual({
      queue: QUEUES.publish,
      removed: 3,
    });
    expect(inline.failed.map((j) => j.id)).toEqual(['scan']);
  });

  it('inline adapter refuses to act on a job that already left the failed set', async () => {
    const { queues } = queueWithFailures(1);
    const publish = findQueue(queues, QUEUES.publish);
    await publish.remove('p0');
    await expect(publish.retry('p0')).rejects.toThrow(ConflictError);
  });
});

describe('retryAdvisory', () => {
  const db = (project: unknown) =>
    ({ videoProject: { findUnique: async () => project } }) as unknown as Pick<
      PrismaClient,
      'videoProject'
    >;
  const job = (name: string) => ({ name, data: { ...base, projectId: 'prj_1', shotId: 's' } });

  it('is silent for non-pipeline jobs and for a live run', async () => {
    expect(await retryAdvisory(db(null), { name: 'publish-video', data: publishJob })).toBeNull();
    const live = { state: 'ASSETS_GENERATING', metadata: { runId: 'run_1' }, deletedAt: null };
    expect(await retryAdvisory(db(live), job('generate-asset'))).toBeNull();
  });

  it('warns when the worker would skip the job', async () => {
    expect(await retryAdvisory(db(null), job('plan-project'))).toMatch(/no longer exists/);
    const newer = { state: 'ASSETS_GENERATING', metadata: { runId: 'run_2' }, deletedAt: null };
    expect(await retryAdvisory(db(newer), job('compose-video'))).toMatch(/newer run/);
    const failed = { state: 'FAILED', metadata: { runId: 'run_1' }, deletedAt: null };
    expect(await retryAdvisory(db(failed), job('generate-asset'))).toMatch(/Requeue it instead/);
    expect(await retryAdvisory(db(failed), job('plan-project'))).toMatch(/redrive/);
  });
});
