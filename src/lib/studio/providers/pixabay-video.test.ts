import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../errors';
import { createMemoryStockCache } from '../images/stock-cache';
import {
  classifyPixabayVideoError,
  PixabayVideoAdapter,
  pickPixabayRendition,
  pixabayVideoCacheKey,
  pixabayVideoParams,
  rankPixabayHits,
  type PixabayVideoHit,
} from './pixabay-video';
import type { StockFootageRequest } from './interface';

// 22.2 — Pixabay videos as STOCK_FOOTAGE (https://pixabay.com/api/docs/#api_search_videos, read
// 2026-10-06): request building, rendition choice, ranking, caching and error classes.

const request: StockFootageRequest = {
  capability: 'stock_footage',
  organisationId: 'org',
  query: 'calm clouds sky',
  durationSec: 8,
  aspectRatio: '9:16',
};

const rendition = (width: number, height: number, name = 'x') => ({
  url: `https://cdn.pixabay.com/video/${name}-${width}x${height}.mp4`,
  width,
  height,
  size: width * height,
});

function hit(id: number, over: Partial<PixabayVideoHit> = {}): PixabayVideoHit {
  return {
    id,
    pageURL: `https://pixabay.com/videos/id-${id}/`,
    tags: 'clouds, sky',
    duration: 12,
    user: 'Coverr-Free-Footage',
    user_id: 1281706,
    videos: {
      large: rendition(3840, 2160, `l${id}`),
      medium: rendition(1920, 1080, `m${id}`),
      small: rendition(1280, 720, `s${id}`),
      tiny: rendition(960, 540, `t${id}`),
    },
    ...over,
  };
}

const portrait = (id: number, over: Partial<PixabayVideoHit> = {}) =>
  hit(id, {
    videos: {
      large: { url: '', width: 0, height: 0, size: 0 },
      medium: rendition(1080, 1920, `pm${id}`),
      small: rendition(720, 1280, `ps${id}`),
      tiny: rendition(540, 960, `pt${id}`),
    },
    ...over,
  });

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('pixabayVideoParams', () => {
  it('sends only documented params: keywords, film, safesearch, per_page (no orientation)', () => {
    const params = pixabayVideoParams(request);
    expect(Object.fromEntries(params)).toEqual({
      q: 'calm clouds sky',
      video_type: 'film',
      safesearch: 'true',
      per_page: '20',
    });
    expect(params.has('orientation')).toBe(false);
    expect(params.has('key')).toBe(false);
  });

  it('caps q at 100 characters and keys the cache without the API key', () => {
    const long = pixabayVideoParams({ query: 'word '.repeat(60) });
    expect((long.get('q') ?? '').length).toBeLessThanOrEqual(100);
    const key = pixabayVideoCacheKey(pixabayVideoParams(request));
    expect(key).toMatch(/^pixabay-video:[0-9a-f]{64}$/);
    expect(key).toBe(pixabayVideoCacheKey(pixabayVideoParams(request)));
  });
});

describe('pickPixabayRendition', () => {
  it('takes the smallest rendition at least 1080 px tall', () => {
    expect(pickPixabayRendition(hit(1).videos)).toMatchObject({ name: 'medium', height: 1080 });
    expect(pickPixabayRendition(portrait(2).videos)).toMatchObject({ name: 'small', height: 1280 });
  });

  it('falls back to the tallest when none is 1080 px tall, and skips an empty large', () => {
    const videos = {
      large: { url: '', width: 0, height: 0, size: 0 },
      medium: rendition(1280, 720),
      small: rendition(960, 540),
    };
    expect(pickPixabayRendition(videos)).toMatchObject({ name: 'medium', height: 720 });
    expect(pickPixabayRendition({})).toBeUndefined();
  });
});

describe('rankPixabayHits', () => {
  it('drops clips shorter than the shot and puts portrait clips first for 9:16', () => {
    const ranked = rankPixabayHits(
      [hit(1), portrait(2), portrait(3, { duration: 5 }), hit(4, { duration: 30 })],
      request,
    );
    expect(ranked.map((h) => h.id)).toEqual([2, 1, 4]);
  });

  it('keeps Pixabay’s order for landscape outputs', () => {
    expect(
      rankPixabayHits([hit(1), portrait(2)], { ...request, aspectRatio: '16:9' }).map((h) => h.id),
    ).toEqual([1, 2]);
  });
});

describe('PixabayVideoAdapter', () => {
  it('finds a portrait clip, records the licence and the Pixabay credit, costs 0p', async () => {
    const fetchImpl = vi.fn(async () => ok({ hits: [hit(1), portrait(2)] }));
    const adapter = new PixabayVideoAdapter({ apiKey: 'k-123', fetchImpl });
    const job = await adapter.submit(request);
    expect(job.estimatedCostPence).toBe(0);
    const result = await adapter.poll(job.providerJobId);
    expect(result.state).toBe('succeeded');
    expect(result.output?.url).toBe('https://cdn.pixabay.com/video/ps2-720x1280.mp4');
    expect(result.output?.metadata).toMatchObject({
      stockItemId: '2',
      rendition: 'small',
      licence: {
        licence: 'pixabay',
        creator: 'Coverr-Free-Footage',
        creatorUrl: 'https://pixabay.com/users/Coverr-Free-Footage-1281706/',
        sourcePageUrl: 'https://pixabay.com/videos/id-2/',
      },
      attribution: 'Video from Pixabay: https://pixabay.com/videos/id-2/',
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://pixabay.com/api/videos/');
    expect(url.searchParams.get('key')).toBe('k-123');
    expect(url.searchParams.get('safesearch')).toBe('true');
  });

  it('caches a search for 24 h (one request for two identical searches)', async () => {
    const fetchImpl = vi.fn(async () => ok({ hits: [hit(1)] }));
    const adapter = new PixabayVideoAdapter({
      apiKey: 'k',
      fetchImpl,
      cache: createMemoryStockCache(),
    });
    await adapter.submit(request);
    await adapter.submit(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails cleanly when nothing long enough matches', async () => {
    const adapter = new PixabayVideoAdapter({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => ok({ hits: [hit(1, { duration: 3 })] })),
    });
    const result = await adapter.poll((await adapter.submit(request)).providerJobId);
    expect(result).toMatchObject({ state: 'failed', error: { class: 'invalid_request' } });
  });

  it.each([
    [429, '', 'rate_limited', true],
    [401, '', 'auth', false],
    [403, '', 'auth', false],
    [400, '[ERROR 400] Invalid or missing API key', 'auth', false],
    [503, '', 'provider_unavailable', true],
  ])('classifies HTTP %i as %s', async (status, body, errorClass, retryable) => {
    const adapter = new PixabayVideoAdapter({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => new Response(body, { status })),
    });
    const err = await adapter.submit(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ providerId: 'pixabay', errorClass, retryable });
  });

  it('treats out-of-credit wording as an account problem', () => {
    expect(classifyPixabayVideoError(400, 'Insufficient credits on this account')).toMatchObject({
      errorClass: 'insufficient_credits',
    });
  });
});
