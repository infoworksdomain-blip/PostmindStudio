import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { FalAdapter, falJobId } from './fal';
import type { FalVideoModelKey } from './fal-models';
import { checkFalOutputUrl } from './fal-output';
import type { TextToVideoRequest } from './interface';

// 24.1 review fixes: the key only goes to fal's documented paths, the downloaded clip URL must be
// on fal's CDN (https://fal.ai/docs/documentation/model-apis/fal-cdn.md, read 2026-10-07), the
// key never appears in errors, and bare HTTP statuses fall through to the shared classes.
const REQ_ID = '764cabcf-b745-4b3e-ae38-1200304cf45b';

function adapter(models: FalVideoModelKey[], ...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    fal: new FalAdapter({ apiKey: 'fal-key', usdToGbpRate: 0.75, models, fetchImpl: fake.fetch }),
    requests: fake.requests,
  };
}

const t2v: TextToVideoRequest = {
  capability: 'text_to_video',
  organisationId: 'org-1',
  prompt: 'Steam rising from fresh bread',
  durationSec: 5,
  aspectRatio: '9:16',
  resolution: '720p',
};

describe('fal submit errors', () => {
  it.each([
    [429, 'rate_limited', true],
    [500, 'provider_unavailable', true],
    [502, 'provider_unavailable', true],
    [503, 'provider_unavailable', true],
  ])(
    'falls through to the status class for a bare HTTP %i',
    async (status, errorClass, retryable) => {
      const { fal } = adapter(['minimax-h3-max'], json({}, status));
      await expect(fal.submit(t2v)).rejects.toMatchObject({ errorClass, retryable });
    },
  );

  it('never puts FAL_KEY into errors, details or the health reason', async () => {
    const secret = 'fal-secret-key-0123456789';
    const fake = fakeFetch(json({ detail: 'Invalid key' }, 401), json({ detail: 'nope' }, 403));
    const fal = new FalAdapter({
      apiKey: secret,
      usdToGbpRate: 0.75,
      models: ['ltx-2.3-fast'],
      fetchImpl: fake.fetch,
    });
    const err = (await fal.submit(t2v).catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(`${err.message} ${JSON.stringify(err.details)} ${String(err.stack)}`).not.toContain(
      secret,
    );
    const health = await fal.healthCheck();
    expect(JSON.stringify(health)).not.toContain(secret);
    expect(fake.requests.every((r) => r.headers.authorization === `Key ${secret}`)).toBe(true);
  });
});

describe('fal poll URL safety', () => {
  const jobId = falJobId('minimax-h3-max', 't2v', REQ_ID);
  const base = `https://queue.fal.run/minimax/h3-max/text-to-video/requests/${REQ_ID}`;

  it.each([
    'https://evil.example/steal',
    `https://queue.fal.run/other-app/requests/${REQ_ID}/response`,
  ])('ignores a forged response_url (%s): the key only goes to the built path', async (forged) => {
    const { fal, requests } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED', response_url: forged }),
      json({ video: { url: 'https://v3.fal.media/files/y.mp4' } }),
    );
    expect((await fal.poll(jobId)).state).toBe('succeeded');
    expect(requests.map((r) => r.url)).toEqual([`${base}/status`, `${base}/response`]);
    expect(requests.every((r) => r.headers.authorization === 'Key fal-key')).toBe(true);
    expect(requests.some((r) => r.url === forged)).toBe(false);
  });

  it.each([
    'https://evil.example/x.mp4',
    'https://fal.media.evil.example/x.mp4',
    'https://evilfal.media/x.mp4',
    'http://v3.fal.media/x.mp4',
    'https://user:pw@v3.fal.media/x.mp4',
    'not a url',
  ])("refuses a clip URL off fal's CDN (%s) without retrying", async (videoUrl) => {
    const { fal } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED' }),
      json({ video: { url: `${videoUrl}?token=SECRET` } }),
    );
    const result = await fal.poll(jobId);
    expect(result).toMatchObject({
      state: 'failed',
      error: { class: 'unknown', retryable: false },
    });
    expect(result.error?.message).not.toContain('SECRET');
    expect(result.error?.message).not.toContain('pw');
  });

  it.each([
    'https://v3.fal.media/files/a.mp4',
    'https://v3b.fal.media/files/b/x/a.mp4',
    'https://fal.media/files/a.mp4',
    'https://cdn.fal.run/a.mp4',
  ])("accepts a clip on fal's CDN (%s)", async (videoUrl) => {
    const { fal } = adapter(
      ['minimax-h3-max'],
      json({ status: 'COMPLETED' }),
      json({ video: { url: videoUrl } }),
    );
    expect(await fal.poll(jobId)).toMatchObject({ state: 'succeeded', output: { url: videoUrl } });
  });
});

describe('checkFalOutputUrl', () => {
  it('returns the normalised URL for fal CDN hosts and a query-free reason otherwise', () => {
    expect(checkFalOutputUrl('https://V3.FAL.MEDIA/files/a.mp4')).toEqual({
      ok: true,
      url: 'https://v3.fal.media/files/a.mp4',
    });
    expect(checkFalOutputUrl(undefined)).toMatchObject({ ok: false });
    expect(checkFalOutputUrl(42)).toMatchObject({ ok: false });
    expect(checkFalOutputUrl('https://evil.example/x.mp4?sig=abc')).toEqual({
      ok: false,
      reason: "fal video URL is not on fal's CDN (https://evil.example)",
    });
  });
});
