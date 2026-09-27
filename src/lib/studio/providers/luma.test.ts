import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { classifyFailureCode, LumaAdapter, lumaDuration } from './luma';

// Fixtures follow docs.agents.lumalabs.ai (generation create/get shapes, failure codes, errors).
const NOW = Date.parse('2026-09-27T12:00:00Z');
const GEN_ID = 'd290f1ee-6c54-4b01-90e6-d701748f0851';

function adapter(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    luma: new LumaAdapter({
      apiKey: 'luma-api-key',
      usdToGbpRate: 0.75,
      fetchImpl: fake.fetch,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

const queued = {
  id: GEN_ID,
  type: 'video',
  state: 'queued',
  model: 'ray-3.2',
  created_at: '2026-05-26T12:00:00Z',
  output: [],
  failure_reason: null,
  failure_code: null,
};

const t2v = {
  capability: 'text_to_video' as const,
  organisationId: 'org-1',
  prompt: 'Steam rising from fresh bread',
  durationSec: 4,
  aspectRatio: '9:16' as const,
};

describe('LumaAdapter.submit', () => {
  it('posts a ray-3.2 text-to-video generation with bearer auth', async () => {
    const { luma, requests } = adapter(json(queued, 201));
    const submitted = await luma.submit(t2v);
    expect(requests[0]).toMatchObject({
      url: 'https://agents.lumalabs.ai/v1/generations',
      method: 'POST',
      headers: { authorization: 'Bearer luma-api-key' },
      body: {
        model: 'ray-3.2',
        type: 'video',
        prompt: t2v.prompt,
        aspect_ratio: '9:16',
        video: { resolution: '720p', duration: '5s' },
      },
    });
    // $0.30 per 5s 720p SDR * 0.75 = 22.5p → 23p (rounded up)
    expect(submitted).toEqual({
      providerJobId: GEN_ID,
      estimatedCostPence: 23,
      estimatedReadyAt: new Date(NOW + 120_000),
    });
  });

  it('animates a source frame with one keyframe at index 0 and uses 10s for long shots', async () => {
    const { luma, requests } = adapter(json(queued, 201));
    const submitted = await luma.submit({
      ...t2v,
      capability: 'image_to_video',
      imageUrl: 'https://cdn.example/frame.png',
      durationSec: 8,
      aspectRatio: '4:5',
    });
    expect(requests[0]?.body).toEqual({
      model: 'ray-3.2',
      type: 'video',
      prompt: t2v.prompt,
      aspect_ratio: '3:4', // 4:5 is not offered; nearest portrait ratio
      video: {
        resolution: '720p',
        duration: '10s',
        keyframes: [{ url: 'https://cdn.example/frame.png' }],
        keyframe_indexes: [0],
      },
    });
    // $0.90 per 10s * 0.75 = 67.5p → 68p
    expect(submitted.estimatedCostPence).toBe(68);
  });

  it.each([
    [{ durationSec: 0.5 }, '1–10s'],
    [{ durationSec: 11 }, '1–10s'],
    [{ prompt: '   ' }, '1–6000 characters'],
    [{ prompt: 'x'.repeat(6001) }, '1–6000 characters'],
  ])('rejects invalid input %o without calling Luma', async (patch, message) => {
    const { luma, requests } = adapter();
    await expect(luma.submit({ ...t2v, ...patch })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
      message: expect.stringContaining(message),
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects capabilities it does not have', async () => {
    const { luma } = adapter();
    await expect(
      luma.submit({ capability: 'tts', organisationId: 'o', text: 'hi', voiceId: 'v' }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });

  it.each([
    [400, 'invalid_request', false, 'Unknown model: ray-2'],
    [401, 'auth', false, 'Missing or invalid API key'],
    [402, 'insufficient_credits', false, 'Insufficient balance. Please add funds to continue.'],
    [413, 'invalid_request', false, 'source: image exceeds 50 MB limit'],
    [422, 'invalid_request', false, 'image_ref[0]: failed to fetch URL'],
    [429, 'rate_limited', true, 'Too many concurrent jobs'],
    [502, 'provider_unavailable', true, 'source: fetch proxy unavailable'],
    [503, 'provider_unavailable', true, 'Media URL ingestion is unavailable'],
  ])('maps HTTP %i to %s', async (status, errorClass, retryable, detail) => {
    const { luma } = adapter(json({ detail }, status));
    await expect(luma.submit(t2v)).rejects.toMatchObject({
      errorClass,
      retryable,
      message: detail,
    });
  });

  it('maps network failures to retryable provider_unavailable', async () => {
    const { luma } = adapter(new TypeError('fetch failed'));
    await expect(luma.submit(t2v)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });
});

describe('LumaAdapter.poll', () => {
  it.each(['queued', 'processing'])('treats %s as running', async (state) => {
    const { luma, requests } = adapter(json({ ...queued, state }));
    await expect(luma.poll(GEN_ID)).resolves.toEqual({ state: 'running' });
    expect(requests[0]?.url).toBe(`https://agents.lumalabs.ai/v1/generations/${GEN_ID}`);
  });

  it('returns the presigned video URL on completion (submit-time cost stands)', async () => {
    const url = `https://storage.example.com/generations/${GEN_ID}/output.mp4?X-Amz-Expires=3600`;
    const { luma } = adapter(
      json({ ...queued, state: 'completed', output: [{ type: 'video', url }] }),
    );
    const polled = await luma.poll(GEN_ID);
    expect(polled).toEqual({
      state: 'succeeded',
      output: {
        url,
        metadata: {
          generationId: GEN_ID,
          model: 'ray-3.2',
          resolution: '720p',
          urlExpiresWithinHours: 1,
        },
      },
    });
  });

  it('reports a completed generation without a video as a retryable failure', async () => {
    const { luma } = adapter(json({ ...queued, state: 'completed', output: [] }));
    await expect(luma.poll(GEN_ID)).resolves.toMatchObject({
      state: 'failed',
      error: { retryable: true },
    });
  });

  it('classifies failures by failure_code and records no charge', async () => {
    const { luma } = adapter(
      json({
        ...queued,
        state: 'failed',
        failure_code: 'content_moderated',
        failure_reason: 'Generation output was flagged by our content moderation system.',
      }),
    );
    const polled = await luma.poll(GEN_ID);
    expect(polled).toEqual({
      state: 'failed',
      error: {
        class: 'content_policy',
        retryable: false,
        message:
          'content_moderated: Generation output was flagged by our content moderation system.',
      },
    });
  });

  it('reports a missing generation as retryable result_expired', async () => {
    const { luma } = adapter(json({ detail: 'Generation not found' }, 404));
    await expect(luma.poll('gone')).resolves.toMatchObject({
      error: { class: 'result_expired', retryable: true },
    });
  });

  it('propagates other poll errors', async () => {
    const { luma } = adapter(json({ detail: 'Missing or invalid API key' }, 401));
    await expect(luma.poll(GEN_ID)).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('treats an unrecognized (unvalidated JSON) state as a retryable unknown failure, not undefined', async () => {
    const { luma } = adapter(json({ ...queued, state: 'archived' }, 200));
    await expect(luma.poll(GEN_ID)).resolves.toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
  });
});

describe('classifyFailureCode', () => {
  it.each([
    [null, 'provider_unavailable', true],
    ['generation_failed', 'provider_unavailable', true],
    ['output_not_found', 'provider_unavailable', true],
    ['rate_limited', 'rate_limited', true],
    ['content_moderated', 'content_policy', false],
    ['budget_exhausted', 'insufficient_credits', false],
    ['image_too_large', 'invalid_request', false],
    ['unsupported_format', 'invalid_request', false],
    ['corrupt_input', 'invalid_request', false],
    ['invalid_request', 'invalid_request', false],
    ['something_new', 'unknown', false],
  ])('%s → %s', (code, errorClass, retryable) => {
    expect(classifyFailureCode(code)).toEqual({ class: errorClass, retryable });
  });
});

describe('lumaDuration', () => {
  it.each([
    [2, '5s'],
    [5, '5s'],
    [5.1, '10s'],
    [10, '10s'],
  ])('%ss → %s', (sec, duration) => {
    expect(lumaDuration(sec)).toBe(duration);
  });
});

describe('LumaAdapter.cancel, healthCheck and estimate', () => {
  it('is honest that Luma has no cancel endpoint and sends nothing', async () => {
    const { luma, requests } = adapter();
    await expect(luma.cancel(GEN_ID)).rejects.toBeInstanceOf(NotImplementedError);
    expect(requests).toHaveLength(0);
  });

  it('probes GET /files for health', async () => {
    const ok = adapter(json({ data: [], has_more: false, next_cursor: null }));
    expect(await ok.luma.healthCheck()).toEqual({ healthy: true });
    expect(ok.requests[0]?.url).toBe('https://agents.lumalabs.ai/v1/files?limit=1');
    const bad = adapter(json({ detail: 'API key has been revoked' }, 401));
    expect((await bad.luma.healthCheck()).reason).toBe('auth: API key has been revoked');
  });

  it('estimates cost per clip length and 0 for other capabilities', () => {
    const { luma } = adapter();
    expect(luma.estimateCostPence(t2v)).toBe(23);
    expect(luma.estimateCostPence({ ...t2v, durationSec: 10 })).toBe(68);
    expect(
      luma.estimateCostPence({
        capability: 'embedding',
        organisationId: 'o',
        input: [],
        dimensions: 1,
      }),
    ).toBe(0);
  });
});
