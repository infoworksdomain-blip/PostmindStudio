import { describe, expect, it } from 'vitest';
import { NotImplementedError, ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { FalAdapter, falJobId } from './fal';
import type { FalVideoModelKey } from './fal-models';
import type { ImageToVideoRequest, TextToVideoRequest } from './interface';

// Fixtures follow fal's queue docs (fal.ai/docs/model-apis/model-endpoints/queue) and error docs
// (fal.ai/docs/documentation/model-apis/errors.md), read 2026-10-06.
const NOW = Date.parse('2026-10-06T12:00:00Z');
const REQ_ID = '764cabcf-b745-4b3e-ae38-1200304cf45b';

function adapter(models: FalVideoModelKey[], ...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    fal: new FalAdapter({
      apiKey: 'fal-key',
      usdToGbpRate: 0.75,
      models,
      fetchImpl: fake.fetch,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

const t2v: TextToVideoRequest = {
  capability: 'text_to_video',
  organisationId: 'org-1',
  prompt: '  Steam rising from fresh bread  ',
  durationSec: 5,
  aspectRatio: '9:16',
  resolution: '720p',
};

const i2v: ImageToVideoRequest = {
  ...t2v,
  capability: 'image_to_video',
  imageUrl: 'https://cdn.example/frame.png',
};

const submitted = (endpoint: string) => ({
  request_id: REQ_ID,
  response_url: `https://queue.fal.run/${endpoint}/requests/${REQ_ID}/response`,
  status_url: `https://queue.fal.run/${endpoint}/requests/${REQ_ID}/status`,
  cancel_url: `https://queue.fal.run/${endpoint}/requests/${REQ_ID}/cancel`,
  queue_position: 0,
});

describe('FalAdapter.submit', () => {
  it('posts MiniMax H3 Max text-to-video to the queue with Key auth', async () => {
    const { fal, requests } = adapter(
      ['minimax-h3-max'],
      json(submitted('minimax/h3-max/text-to-video')),
    );
    const result = await fal.submit(t2v);
    expect(requests[0]).toMatchObject({
      url: 'https://queue.fal.run/minimax/h3-max/text-to-video',
      method: 'POST',
      headers: { authorization: 'Key fal-key', 'content-type': 'application/json' },
      body: {
        prompt: 'Steam rising from fresh bread',
        prompt_expansion_mode: 'balanced',
        duration: 5,
        resolution: '768P',
        aspect_ratio: '9:16',
      },
    });
    // 5 s × $0.08 (768P) = $0.40 × 0.75 = 30p
    expect(result).toEqual({
      providerJobId: `minimax-h3-max:t2v:${REQ_ID}`,
      estimatedCostPence: 30,
      estimatedReadyAt: new Date(NOW + 180_000),
    });
  });

  it('sends the source frame for image-to-video (no aspect ratio: the frame sets it)', async () => {
    const { fal, requests } = adapter(
      ['minimax-h3-max'],
      json(submitted('minimax/h3-max/image-to-video')),
    );
    const result = await fal.submit({ ...i2v, aspectRatio: '4:5', resolution: '1080p' });
    expect(requests[0]?.url).toBe('https://queue.fal.run/minimax/h3-max/image-to-video');
    expect(requests[0]?.body).toEqual({
      prompt: 'Steam rising from fresh bread',
      prompt_expansion_mode: 'balanced',
      duration: 5,
      resolution: '1080P',
      image_url: 'https://cdn.example/frame.png',
    });
    // 5 s × $0.16 = $0.80 × 0.75 = 60p
    expect(result.estimatedCostPence).toBe(60);
    expect(result.providerJobId).toBe(`minimax-h3-max:i2v:${REQ_ID}`);
  });

  it('rounds LTX-2.3 Fast up to its next length and asks for a silent 1080p clip', async () => {
    const { fal, requests } = adapter(
      ['ltx-2.3-fast'],
      json(submitted('fal-ai/ltx-2.3/text-to-video/fast')),
    );
    const result = await fal.submit({ ...t2v, durationSec: 7, aspectRatio: '4:5' });
    expect(requests[0]).toMatchObject({
      url: 'https://queue.fal.run/fal-ai/ltx-2.3/text-to-video/fast',
      body: {
        prompt: 'Steam rising from fresh bread',
        duration: 8,
        resolution: '1080p',
        aspect_ratio: '9:16',
        fps: 25,
        generate_audio: false,
      },
    });
    // 8 s × $0.06 = $0.48 × 0.75 = 36p
    expect(result.estimatedCostPence).toBe(36);
  });

  it('uses LTX auto ratio and Veo Lite "Ns" durations for image-to-video', async () => {
    const ltx = adapter(['ltx-2.3-fast'], json(submitted('fal-ai/ltx-2.3/image-to-video/fast')));
    await ltx.fal.submit(i2v);
    expect(ltx.requests[0]?.body).toMatchObject({ aspect_ratio: 'auto', duration: 6 });
    expect(ltx.requests[0]?.body).toHaveProperty('image_url', i2v.imageUrl);

    const veo = adapter(['veo-3.1-lite'], json(submitted('fal-ai/veo3.1/lite/image-to-video')));
    const result = await veo.fal.submit(i2v);
    expect(veo.requests[0]).toMatchObject({
      url: 'https://queue.fal.run/fal-ai/veo3.1/lite/image-to-video',
      body: {
        duration: '6s',
        resolution: '720p',
        aspect_ratio: 'auto',
        generate_audio: false,
        image_url: i2v.imageUrl,
      },
    });
    // 6 s × $0.03 = $0.18 × 0.75 = 13.5p → 14p
    expect(result.estimatedCostPence).toBe(14);
  });

  it('falls through the enabled models in order to one that fits the shot', async () => {
    const { fal, requests } = adapter(
      ['veo-3.1-lite', 'ltx-2.3-fast'],
      json(submitted('fal-ai/ltx-2.3/text-to-video/fast')),
    );
    // 12 s is past Veo Lite's 8 s, so LTX (up to 20 s) takes it.
    const result = await fal.submit({ ...t2v, durationSec: 12 });
    expect(requests[0]?.url).toBe('https://queue.fal.run/fal-ai/ltx-2.3/text-to-video/fast');
    expect(result.providerJobId).toBe(`ltx-2.3-fast:t2v:${REQ_ID}`);
  });

  it('rejects shots no enabled model can render, without calling fal', async () => {
    const { fal, requests } = adapter(['veo-3.1-lite']);
    expect(fal.supportsRequest({ ...t2v, durationSec: 9 })).toBe(false);
    expect(fal.supportsRequest({ ...t2v, aspectRatio: '1:1' })).toBe(false);
    expect(fal.estimateCostPence({ ...t2v, durationSec: 9 })).toBe(0);
    await expect(fal.submit({ ...t2v, durationSec: 9 })).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    await expect(fal.submit({ ...i2v, imageUrl: 'http://cdn.example/f.png' })).rejects.toThrow(
      /https/,
    );
    await expect(
      fal.submit({ capability: 'tts', organisationId: 'o', text: 't', voiceId: 'v' }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(requests).toHaveLength(0);
  });

  it('fails retryably when the queue answers without a request id', async () => {
    const { fal } = adapter(['minimax-h3-max'], json({}));
    await expect(fal.submit(t2v)).rejects.toMatchObject({ errorClass: 'unknown', retryable: true });
  });

  it.each([
    [401, { detail: 'Invalid key' }, 'auth'],
    [403, { detail: 'Forbidden' }, 'auth'],
    [403, { detail: 'User is locked. Reason: Exhausted balance.' }, 'insufficient_credits'],
    [402, { detail: 'Payment required' }, 'insufficient_credits'],
    [429, { detail: 'Too many requests' }, 'rate_limited'],
    [
      422,
      { detail: [{ loc: ['body', 'prompt'], msg: 'flagged', type: 'content_policy_violation' }] },
      'content_policy',
    ],
    [
      422,
      { detail: [{ loc: ['body', 'duration'], msg: 'bad', type: 'one_of' }] },
      'invalid_request',
    ],
    [504, { detail: 'timed out', error_type: 'request_timeout' }, 'timeout'],
    [503, { detail: 'no runner', error_type: 'runner_scheduling_failure' }, 'provider_unavailable'],
  ])('maps HTTP %i %j to %s', async (status, body, errorClass) => {
    const { fal } = adapter(['minimax-h3-max'], json(body, status));
    await expect(fal.submit(t2v)).rejects.toMatchObject({ errorClass, details: { status } });
  });
});

describe('FalAdapter.poll', () => {
  const jobId = falJobId('minimax-h3-max', 't2v', REQ_ID);
  const base = `https://queue.fal.run/minimax/h3-max/text-to-video/requests/${REQ_ID}`;

  it.each(['IN_QUEUE', 'IN_PROGRESS'])('reports %s as running', async (status) => {
    const { fal, requests } = adapter(['minimax-h3-max'], json({ status, request_id: REQ_ID }));
    expect(await fal.poll(jobId)).toEqual({ state: 'running' });
    expect(requests[0]).toMatchObject({ url: `${base}/status`, method: 'GET' });
  });

  it('fetches the result from response_url and returns the video URL', async () => {
    const { fal, requests } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED', request_id: REQ_ID, response_url: `${base}/response` }),
      json({
        video: {
          url: 'https://v3.fal.media/files/x/clip.mp4',
          content_type: 'video/mp4',
          file_size: 1234,
        },
      }),
    );
    expect(await fal.poll(jobId)).toEqual({
      state: 'succeeded',
      output: {
        url: 'https://v3.fal.media/files/x/clip.mp4',
        metadata: {
          requestId: REQ_ID,
          model: 'minimax-h3-max',
          endpointId: 'minimax/h3-max/text-to-video',
          contentType: 'video/mp4',
          fileSize: 1234,
          hostedBy: 'fal-cdn',
        },
      },
    });
    expect(requests[1]?.url).toBe(`${base}/response`);
  });

  it('builds the response URL itself when the status omits or misplaces it', async () => {
    const { fal, requests } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED', response_url: 'https://evil.example/steal' }),
      json({ video: { url: 'https://v3.fal.media/files/y.mp4' } }),
    );
    expect((await fal.poll(jobId)).state).toBe('succeeded');
    expect(requests[1]?.url).toBe(`${base}/response`);
  });

  it('fails a completed request that carries an error, classified by error_type', async () => {
    const { fal } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED', error: 'Timed out', error_type: 'request_timeout' }),
    );
    expect(await fal.poll(jobId)).toEqual({
      state: 'failed',
      error: { class: 'timeout', message: 'request_timeout: Timed out', retryable: true },
    });
  });

  it('fails when the result has no https video URL', async () => {
    const { fal } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED' }),
      json({ video: null }),
    );
    expect(await fal.poll(jobId)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: true },
    });
  });

  it('reports a content-policy refusal from the result endpoint as an error', async () => {
    const { fal } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED' }),
      json({ detail: [{ loc: ['body'], msg: 'no', type: 'content_policy_violation' }] }, 422),
    );
    await expect(fal.poll(jobId)).rejects.toMatchObject({ errorClass: 'content_policy' });
  });

  it('handles unknown requests, statuses and job ids', async () => {
    const gone = adapter(['minimax-h3-max'], json({ detail: 'Not found' }, 404));
    expect(await gone.fal.poll(jobId)).toMatchObject({
      state: 'failed',
      error: { class: 'result_expired', retryable: true },
    });
    const odd = adapter(['minimax-h3-max'], json({ status: 'PAUSED' }));
    expect(await odd.fal.poll(jobId)).toMatchObject({
      state: 'failed',
      error: { class: 'unknown' },
    });
    const none = adapter(['minimax-h3-max']);
    expect(await none.fal.poll('../../etc:t2v:abc')).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request', retryable: false },
    });
    expect(none.requests).toHaveLength(0);
  });
});

describe('FalAdapter.cancel', () => {
  const jobId = falJobId('ltx-2.3-fast', 'i2v', REQ_ID);
  const base = `https://queue.fal.run/fal-ai/ltx-2.3/image-to-video/fast/requests/${REQ_ID}`;

  it('cancels a queued request with PUT', async () => {
    const { fal, requests } = adapter(
      ['ltx-2.3-fast'],
      json({ status: 'IN_QUEUE' }),
      json({ status: 'CANCELLATION_REQUESTED' }, 202),
    );
    await fal.cancel(jobId);
    expect(requests[1]).toMatchObject({ url: `${base}/cancel`, method: 'PUT' });
  });

  it('treats ALREADY_COMPLETED and finished requests as nothing to cancel', async () => {
    const raced = adapter(
      ['ltx-2.3-fast'],
      json({ status: 'IN_QUEUE' }),
      json({ status: 'ALREADY_COMPLETED' }, 400),
    );
    await expect(raced.fal.cancel(jobId)).resolves.toBeUndefined();
    const done = adapter(['ltx-2.3-fast'], json({ status: 'COMPLETED' }));
    await expect(done.fal.cancel(jobId)).resolves.toBeUndefined();
    expect(done.requests).toHaveLength(1);
  });

  it('refuses to claim a running request was cancelled', async () => {
    const { fal } = adapter(['ltx-2.3-fast'], json({ status: 'IN_PROGRESS' }));
    await expect(fal.cancel(jobId)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(fal.cancel('nope')).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

describe('FalAdapter.healthCheck', () => {
  it('reads the platform pricing endpoint for the first enabled model', async () => {
    const { fal, requests } = adapter(['ltx-2.3-fast'], json({ prices: [] }));
    expect(await fal.healthCheck()).toEqual({ healthy: true });
    expect(requests[0]).toMatchObject({
      url: 'https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai%2Fltx-2.3%2Ftext-to-video%2Ffast',
      headers: { authorization: 'Key fal-key' },
    });
  });

  it('reports an auth failure', async () => {
    const { fal } = adapter(['ltx-2.3-fast'], json({ detail: 'bad key' }, 401));
    expect(await fal.healthCheck()).toEqual({ healthy: false, reason: 'auth: bad key' });
  });
});
