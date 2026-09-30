import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { evaluateContentSafety } from '../pipeline/quality-checks';
import { summariseFrames } from './hive-scan';
import {
  framesFromV3,
  MAX_V3_VIDEO_SEC,
  sampleTimes,
  scanWithV3,
  V3_FRAME_MAX_WIDTH,
  V3_URL,
  v3FrameCount,
  v3RequestCount,
  type HiveV3Response,
} from './hive-v3';

// 20.6 — fixtures follow the V3 response documented at
// https://docs.thehive.ai/docs/visual-moderation-playground (read 2026-09-30).

const imageResponse: HiveV3Response = {
  task_id: '123456',
  model: 'hive/visual-moderation',
  version: '1',
  output: [
    {
      extra: [],
      classes: [
        { class_name: 'general_not_nsfw_not_suggestive', value: 9.6e-9 },
        { class_name: 'general_nsfw', value: 0.9999998807907104 },
        { class_name: 'no_gun', value: 1.0 },
      ],
    },
  ],
};

const videoResponse: HiveV3Response = {
  task_id: 'v',
  output: [
    {
      extra: [
        { name: 'frame_index', value: 0 },
        { name: 'timestamp', value: 0.0 },
      ],
      classes: [
        { class_name: 'general_nsfw', value: 0.01 },
        { class_name: 'gun_in_hand', value: 0.2 },
      ],
    },
    {
      extra: [
        { name: 'frame_index', value: 1 },
        { name: 'timestamp', value: 1.0 },
      ],
      classes: [
        { class_name: 'general_nsfw', value: 0.02 },
        { class_name: 'gun_in_hand', value: 0.85 },
      ],
    },
  ],
};

const request = {
  capability: 'content_safety' as const,
  organisationId: 'org-1',
  mediaUrl: 'https://r2.example/render.mp4?sig=1',
  durationSec: 30,
};

function client(fetchImpl: typeof fetch, extra: { maxFrames?: number; frameJpeg?: never } = {}) {
  return { secretKey: 'sk-v3', fetchImpl, maxFrames: 10, ...extra };
}

describe('framesFromV3', () => {
  it('maps class_name/value to the V2 class/score shape, with video timestamps', () => {
    expect(framesFromV3(videoResponse)).toEqual([
      {
        time: 0,
        classes: [
          { class: 'general_nsfw', score: 0.01 },
          { class: 'gun_in_hand', score: 0.2 },
        ],
      },
      {
        time: 1,
        classes: [
          { class: 'general_nsfw', score: 0.02 },
          { class: 'gun_in_hand', score: 0.85 },
        ],
      },
    ]);
  });

  it('places an image at the given sample time and skips malformed classes', () => {
    const frames = framesFromV3(
      { output: [{ classes: [{ class_name: 'yes_nazi', value: 0.3 }, { value: 1 }, {}] }] },
      42,
    );
    expect(frames).toEqual([{ time: 42, classes: [{ class: 'yes_nazi', score: 0.3 }] }]);
    expect(framesFromV3({})).toEqual([]);
  });

  it('feeds the same Layer 8 policy as V2 (identical class names)', () => {
    const blocked = evaluateContentSafety({ scan: summariseFrames(framesFromV3(imageResponse)) });
    expect(blocked).toMatchObject({ status: 'failed', severity: 'block' });
    expect(blocked.detail).toContain('general_nsfw=1.00');
    const review = evaluateContentSafety({ scan: summariseFrames(framesFromV3(videoResponse)) });
    expect(review).toMatchObject({ status: 'failed', severity: 'error' });
    expect(review.detail).toContain('gun_in_hand=0.85');
  });
});

describe('sampling bounds', () => {
  it('samples mid-points of equal slices, never more than maxFrames', () => {
    expect(sampleTimes(240, 4)).toEqual([30, 90, 150, 210]);
    expect(sampleTimes(600, 10)).toHaveLength(10);
    expect(sampleTimes(61, 60)).toHaveLength(60);
    expect(sampleTimes(3, 10)).toEqual([0.5, 1.5, 2.5]);
    expect(sampleTimes(0, 10)).toEqual([0]);
  });

  it('counts one request up to 60 s and one per sampled frame beyond', () => {
    expect(v3RequestCount(MAX_V3_VIDEO_SEC, 10)).toBe(1);
    expect(v3RequestCount(61, 10)).toBe(10);
    expect(v3RequestCount(480, 5)).toBe(5);
    expect(v3FrameCount(30, 10)).toBe(30);
    expect(v3FrameCount(480, 5)).toBe(5);
  });
});

describe('scanWithV3 — videos up to 60 s', () => {
  it('posts one JSON request with media_url and Bearer secret-key auth', async () => {
    const fake = fakeFetch(json(videoResponse));
    const frames = await scanWithV3(request, client(fake.fetch));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: V3_URL,
      method: 'POST',
      body: { input: [{ media_url: request.mediaUrl }] },
    });
    expect(V3_URL).toBe('https://api.thehive.ai/api/v3/hive/visual-moderation');
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer sk-v3');
    expect(fake.requests[0]?.headers['content-type']).toBe('application/json');
    expect(frames).toHaveLength(2);
  });

  it('a 60 s render is still one request (no sampling)', async () => {
    const fake = fakeFetch(json(videoResponse));
    const frameJpeg = vi.fn();
    await scanWithV3(
      { ...request, durationSec: 60 },
      { ...client(fake.fetch), frameJpeg: frameJpeg as never },
    );
    expect(fake.requests).toHaveLength(1);
    expect(frameJpeg).not.toHaveBeenCalled();
  });

  it('no frames in the response is a retryable failure', async () => {
    const fake = fakeFetch(json({ task_id: 'x', output: [] }));
    await expect(scanWithV3(request, client(fake.fetch))).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
      message: 'Hive V3 returned no frames',
    });
  });

  it('429 is a retryable rate_limited error that names the daily limit', async () => {
    const fake = fakeFetch(
      json({ return_code: 429, message: 'Project has been rate limited' }, 429),
    );
    const err = await scanWithV3(request, client(fake.fetch)).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorClass: 'rate_limited', retryable: true });
    expect((err as Error).message).toContain('about 100 requests a day');
    expect((err as Error).message).toContain('Project has been rate limited');
  });

  it('403 says which key to use; 405 is insufficient balance; 5xx stays retryable', async () => {
    const auth = fakeFetch(json({ return_code: 403, message: 'Invalid Auth Token' }, 403));
    const e1 = await scanWithV3(request, client(auth.fetch)).catch((e: unknown) => e);
    expect(e1).toMatchObject({ errorClass: 'auth', retryable: false });
    expect((e1 as Error).message).toContain('not the Access Key ID');

    const broke = fakeFetch(json({ return_code: 405, message: 'no balance' }, 405));
    await expect(scanWithV3(request, client(broke.fetch))).rejects.toMatchObject({
      errorClass: 'insufficient_credits',
      retryable: false,
    });

    const down = fakeFetch(json({ message: 'maintenance' }, 503));
    await expect(scanWithV3(request, client(down.fetch))).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
      message: 'maintenance',
    });
  });
});

describe('scanWithV3 — renders over 60 s (frame sampling)', () => {
  const long = { ...request, durationSec: 240 };

  it('uploads each sampled frame as multipart `media`, bounded by maxFrames', async () => {
    const fake = fakeFetch(json(imageResponse), json(imageResponse), json(imageResponse));
    const frameJpeg = vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const frames = await scanWithV3(long, {
      secretKey: 'sk-v3',
      fetchImpl: fake.fetch,
      maxFrames: 3,
      frameJpeg,
    });
    expect(frameJpeg.mock.calls).toEqual([
      [long.mediaUrl, 40, V3_FRAME_MAX_WIDTH],
      [long.mediaUrl, 120, V3_FRAME_MAX_WIDTH],
      [long.mediaUrl, 200, V3_FRAME_MAX_WIDTH],
    ]);
    expect(fake.requests).toHaveLength(3);
    for (const r of fake.requests) {
      expect(r.url).toBe(V3_URL);
      expect(r.headers.authorization).toBe('Bearer sk-v3');
      const media = (r.body as FormData).get('media');
      expect(media).toBeInstanceOf(Blob);
      expect((media as Blob).type).toBe('image/jpeg');
    }
    expect(frames.map((f) => f.time)).toEqual([40, 120, 200]);
    const scan = summariseFrames(frames);
    expect(scan).toMatchObject({
      framesAnalysed: 3,
      maxScores: { general_nsfw: 0.9999998807907104 },
    });
    expect(scan.flaggedFrames.map((f) => f.time)).toEqual([40, 120, 200]);
  });

  it('fails closed without a frame grabber, before any request', async () => {
    const fake = fakeFetch();
    await expect(scanWithV3(long, client(fake.fetch))).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it('a failed frame grab or a failed frame request fails the whole scan', async () => {
    const grabFails = vi.fn(async () => {
      throw new Error('ffmpeg exploded');
    });
    await expect(
      scanWithV3(long, { ...client(fakeFetch().fetch), frameJpeg: grabFails as never }),
    ).rejects.toMatchObject({
      errorClass: 'invalid_request',
      message: expect.stringContaining('ffmpeg exploded'),
    });

    const fake = fakeFetch(json(imageResponse), json({ message: 'limited' }, 429));
    const frameJpeg = vi.fn(async () => new Uint8Array([1]));
    await expect(
      scanWithV3(long, { secretKey: 'k', fetchImpl: fake.fetch, maxFrames: 5, frameJpeg }),
    ).rejects.toMatchObject({ errorClass: 'rate_limited', retryable: true });
    expect(fake.requests).toHaveLength(2); // stops at the first failure
  });
});
