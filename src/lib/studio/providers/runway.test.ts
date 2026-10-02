import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { classifyFailureCode, RunwayAdapter } from './runway';

// Fixtures follow docs.dev.runwayml.com (task create/poll shapes, failure codes).
const NOW = Date.parse('2026-09-27T12:00:00Z');

function adapter(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    runway: new RunwayAdapter({
      apiKey: 'rw-key',
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

const t2v = {
  capability: 'text_to_video' as const,
  organisationId: 'org-1',
  prompt: 'Steam rising from fresh bread',
  durationSec: 5,
  aspectRatio: '9:16' as const,
};

describe('RunwayAdapter.submit', () => {
  it('posts text-to-video to gen4.5 with version + auth headers', async () => {
    const { runway, requests } = adapter(json({ id: 'task-1', estimatedCost: { credits: 60 } }));
    const submitted = await runway.submit(t2v);
    expect(requests[0]).toMatchObject({
      url: 'https://api.dev.runwayml.com/v1/text_to_video',
      method: 'POST',
      headers: { authorization: 'Bearer rw-key', 'x-runway-version': '2024-11-06' },
      body: { model: 'gen4.5', promptText: t2v.prompt, ratio: '720:1280', duration: 5 },
    });
    // 60 credits * $0.01 * 0.75 = 45p
    expect(submitted).toEqual({
      providerJobId: 'task-1',
      estimatedCostPence: 45,
      estimatedReadyAt: new Date(NOW + 120_000),
    });
  });

  it('posts image-to-video to gen4_turbo with the source frame', async () => {
    const { runway, requests } = adapter(json({ id: 'task-2' }));
    const submitted = await runway.submit({
      ...t2v,
      capability: 'image_to_video',
      imageUrl: 'https://cdn.example/frame.png',
      aspectRatio: '1:1',
    });
    expect(requests[0]?.url).toBe('https://api.dev.runwayml.com/v1/image_to_video');
    expect(requests[0]?.body).toEqual({
      model: 'gen4_turbo',
      promptText: t2v.prompt,
      promptImage: 'https://cdn.example/frame.png',
      ratio: '960:960',
      duration: 5,
    });
    // no estimatedCost in response → 5s * 5 credits = 25 credits → 18.75p → 19p
    expect(submitted.estimatedCostPence).toBe(19);
  });

  it.each([
    [{ durationSec: 1 }, 'must be 2–10s'],
    [{ durationSec: 11 }, 'must be 2–10s'],
    [{ aspectRatio: '1:1' as const }, 'not supported'],
  ])('rejects invalid input %o without calling Runway', async (patch, message) => {
    const { runway, requests } = adapter();
    await expect(runway.submit({ ...t2v, ...patch })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      message: expect.stringContaining(message),
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    [429, 'rate_limited', true],
    [503, 'provider_unavailable', true],
    [401, 'auth', false],
    [400, 'invalid_request', false],
  ])('maps HTTP %i to %s', async (status, errorClass, retryable) => {
    const { runway } = adapter(json({ error: 'nope' }, status));
    await expect(runway.submit(t2v)).rejects.toMatchObject({
      errorClass,
      retryable,
      message: 'nope',
    });
  });

  it('20.19: maps the production "not enough credits" 400 to insufficient_credits', async () => {
    const { runway } = adapter(
      json({ error: 'You do not have enough credits to run this task.' }, 400),
    );
    await expect(runway.submit(t2v)).rejects.toMatchObject({
      providerId: 'runway',
      errorClass: 'insufficient_credits',
      retryable: false,
      message: 'You do not have enough credits to run this task.',
    });
  });

  it('maps network failures to retryable provider_unavailable', async () => {
    const { runway } = adapter(new TypeError('fetch failed'));
    await expect(runway.submit(t2v)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('RunwayAdapter.poll', () => {
  it.each(['PENDING', 'THROTTLED', 'RUNNING'])('treats %s as running', async (status) => {
    const { runway, requests } = adapter(json({ id: 'task-1', status, progress: 0.2 }));
    await expect(runway.poll('task-1')).resolves.toEqual({ state: 'running' });
    expect(requests[0]?.url).toBe('https://api.dev.runwayml.com/v1/tasks/task-1');
  });

  it('returns the output URL and actual cost on success', async () => {
    const { runway } = adapter(
      json({
        id: 'task-1',
        status: 'SUCCEEDED',
        output: ['https://runway.out/v.mp4'],
        cost: { credits: 60 },
      }),
    );
    const polled = await runway.poll('task-1');
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: {
        url: 'https://runway.out/v.mp4',
        metadata: { credits: 60, costPence: 45, urlExpiresWithinHours: 24 },
      },
    });
  });

  it('classifies failures by failureCode', async () => {
    const { runway } = adapter(
      json({ id: 't', status: 'FAILED', failure: 'Moderation', failureCode: 'SAFETY.INPUT.TEXT' }),
    );
    await expect(runway.poll('t')).resolves.toMatchObject({
      state: 'failed',
      error: {
        class: 'content_policy',
        retryable: false,
        message: 'SAFETY.INPUT.TEXT: Moderation',
      },
    });
  });

  it('20.19: a task that failed for lack of credits is insufficient_credits', async () => {
    const { runway } = adapter(
      json({
        id: 't',
        status: 'FAILED',
        failure: 'You do not have enough credits to run this task.',
        failureCode: null,
      }),
    );
    await expect(runway.poll('t')).resolves.toMatchObject({
      state: 'failed',
      error: { class: 'insufficient_credits', retryable: false },
    });
  });

  it('reports credits billed for a failed task', async () => {
    const { runway } = adapter(
      json({
        id: 't',
        status: 'FAILED',
        failure: 'Moderation',
        failureCode: 'SAFETY.INPUT.TEXT',
        cost: { credits: 60 },
      }),
    );
    await expect(runway.poll('t')).resolves.toMatchObject({
      output: { metadata: { credits: 60, costPence: 45 } },
    });
  });

  it('reports a missing task as retryable result_expired', async () => {
    const { runway } = adapter(json({ error: 'Not found' }, 404));
    await expect(runway.poll('gone')).resolves.toMatchObject({
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('reports cancelled tasks and empty output as failures', async () => {
    const cancelled = adapter(json({ id: 't', status: 'CANCELLED' }));
    await expect(cancelled.runway.poll('t')).resolves.toMatchObject({ state: 'failed' });
    const empty = adapter(json({ id: 't', status: 'SUCCEEDED', output: [] }));
    await expect(empty.runway.poll('t')).resolves.toMatchObject({
      state: 'failed',
      error: { retryable: true },
    });
  });
});

describe('classifyFailureCode', () => {
  it.each([
    [null, 'provider_unavailable', true],
    ['INTERNAL', 'provider_unavailable', true],
    ['INPUT_PREPROCESSING.INTERNAL', 'provider_unavailable', true],
    ['THIRD_PARTY.UNAVAILABLE', 'provider_unavailable', true],
    ['SAFETY.OUTPUT.VIDEO', 'content_policy', false],
    ['INPUT_PREPROCESSING.SAFETY.TEXT', 'content_policy', false],
    ['ASSET.INVALID', 'invalid_request', false],
    ['INTERNAL.BAD_OUTPUT.01', 'invalid_request', false],
    ['SOMETHING.NEW', 'unknown', false],
  ])('%s → %s', (code, errorClass, retryable) => {
    expect(classifyFailureCode(code)).toEqual({ class: errorClass, retryable });
  });
});

describe('RunwayAdapter.cancel and healthCheck', () => {
  it('DELETEs the task and ignores 404', async () => {
    const { runway, requests } = adapter(
      new Response(null, { status: 204 }),
      json({ error: 'gone' }, 404),
    );
    await runway.cancel('task-1');
    await runway.cancel('task-1');
    expect(requests.map((r) => r.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('propagates other cancel failures', async () => {
    const { runway } = adapter(json({ error: 'down' }, 503));
    await expect(runway.cancel('task-1')).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
    });
  });

  it('is healthy with credits, unhealthy with none or on error', async () => {
    expect(await adapter(json({ creditBalance: 500 })).runway.healthCheck()).toEqual({
      healthy: true,
    });
    expect((await adapter(json({ creditBalance: 0 })).runway.healthCheck()).reason).toContain(
      'insufficient_credits',
    );
    expect((await adapter(json({ error: 'bad key' }, 401)).runway.healthCheck()).reason).toContain(
      'auth',
    );
  });

  it('estimates cost from duration and model', () => {
    const { runway } = adapter();
    expect(runway.estimateCostPence(t2v)).toBe(45); // 5s * 12 credits
    expect(
      runway.estimateCostPence({
        capability: 'embedding',
        organisationId: 'o',
        input: [],
        dimensions: 1,
      }),
    ).toBe(0);
  });
});
