import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ProviderError } from '../../errors';
import { storyblocksAuth } from '../images/stock';
import { PexelsVideoAdapter, pickPexelsFile } from './pexels-video';
import { footageKeywords, footageOrientation } from './stock-footage';
import { pickStoryblocksMp4, StoryblocksVideoAdapter } from './storyblocks-video';

// Fixtures follow the vendors' documented shapes (read 2026-09-28):
//  - Storyblocks GET /api/v2/videos/search → { total_results, results: [{ id, title, duration,
//    durationMs }] }; GET /api/v2/videos/stock-item/download/:id → { MP4: { _1080p, _720p }, MOV }
//  - Pexels GET /v1/videos/search → { videos: [{ id, url, duration, user, video_files }] }

const NOW = 1_790_000_000_000;
const request = {
  capability: 'stock_footage' as const,
  organisationId: 'org_1',
  projectId: 'prj_1',
  query: 'A slow close-up of fresh croissants on a bakery counter, warm morning light',
  durationSec: 4,
  aspectRatio: '9:16' as const,
};

describe('footage helpers', () => {
  it('keeps content words only, deduplicated, at most six', () => {
    expect(footageKeywords(request.query)).toEqual([
      'fresh',
      'croissants',
      'bakery',
      'counter',
      'warm',
      'morning',
    ]);
    expect(footageKeywords('!!! the a')).toEqual([]);
  });

  it('maps aspect ratios to clip orientation', () => {
    expect(footageOrientation('9:16')).toBe('vertical');
    expect(footageOrientation('16:9')).toBe('horizontal');
    expect(footageOrientation('1:1')).toBe('any');
  });
});

describe('StoryblocksVideoAdapter', () => {
  function setup(...replies: Parameters<typeof fakeFetch>) {
    const fake = fakeFetch(...replies);
    const adapter = new StoryblocksVideoAdapter({
      publicKey: 'pub',
      privateKey: 'priv',
      fetchImpl: fake.fetch,
      now: () => NOW,
    });
    return { adapter, requests: fake.requests };
  }

  it('searches footage with HMAC auth and returns the 1080p MP4 with licence metadata', async () => {
    const { adapter, requests } = setup(
      json({
        total_results: 2,
        results: [
          { id: 1, title: 'Too short', durationMs: 2500 },
          { id: 555, title: 'Croissants', duration: 12 },
        ],
      }),
      json({
        MP4: {
          _720p: 'https://cdn.sb.example/555_720.mp4',
          _1080p: 'https://cdn.sb.example/555.mp4',
        },
        MOV: { _1080p: 'https://cdn.sb.example/555.mov' },
      }),
    );
    const submitted = await adapter.submit(request);
    expect(submitted.estimatedCostPence).toBe(0);
    const search = new URL(requests[0]!.url);
    expect(search.origin + search.pathname).toBe(
      'https://api.storyblocks.com/api/v2/videos/search',
    );
    const auth = storyblocksAuth(
      { publicKey: 'pub', privateKey: 'priv' },
      '/api/v2/videos/search',
      NOW,
    );
    expect(search.searchParams.get('HMAC')).toBe(auth.get('HMAC'));
    expect(Object.fromEntries(search.searchParams)).toMatchObject({
      APIKEY: 'pub',
      keywords: 'fresh,croissants,bakery,counter,warm,morning',
      content_type: 'footage',
      min_duration: '4',
      orientation: 'vertical',
      safe_search: 'true',
      user_id: 'org_1',
      project_id: 'prj_1',
    });
    const download = new URL(requests[1]!.url);
    expect(download.pathname).toBe('/api/v2/videos/stock-item/download/555');
    expect(download.searchParams.get('HMAC')).toBe(
      storyblocksAuth({ publicKey: 'pub', privateKey: 'priv' }, download.pathname, NOW).get('HMAC'),
    );
    const polled = await adapter.poll(submitted.providerJobId);
    expect(polled).toMatchObject({
      state: 'succeeded',
      output: {
        url: 'https://cdn.sb.example/555.mp4',
        metadata: {
          stockItemId: '555',
          durationSec: 12,
          costPence: 0,
          licence: { licence: 'storyblocks-api', attributionRequired: false },
        },
      },
    });
  });

  it('fails without retry when nothing long enough matches', async () => {
    const { adapter } = setup(json({ results: [{ id: 1, durationMs: 1000 }] }));
    const polled = await adapter.poll((await adapter.submit(request)).providerJobId);
    expect(polled).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request', retryable: false },
    });
  });

  it('classifies HTTP errors and rejects other capabilities', async () => {
    const { adapter } = setup(json({}, 429));
    await expect(adapter.submit(request)).rejects.toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
    });
    await expect(
      adapter.submit({ capability: 'sfx', organisationId: 'o', query: 'x', maxDurationSec: 1 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('errors when the download offers no MP4 and reports health', async () => {
    const { adapter } = setup(
      json({ results: [{ id: 9, duration: 30 }] }),
      json({ MOV: { _1080p: 'https://x.example/a.mov' } }),
      json({ results: [] }),
      json({}, 401),
    );
    await expect(adapter.submit(request)).rejects.toThrow(/no MP4/);
    expect(await adapter.healthCheck()).toEqual({ healthy: true });
    expect((await adapter.healthCheck()).healthy).toBe(false);
  });

  it('picks 1080p, then 720p, then any https MP4', () => {
    expect(pickStoryblocksMp4({ MP4: { _720p: 'https://a/7', _1080p: 'https://a/10' } })).toBe(
      'https://a/10',
    );
    expect(pickStoryblocksMp4({ MP4: { _480p: 'https://a/4' } })).toBe('https://a/4');
    expect(pickStoryblocksMp4({ MP4: { _1080p: 'http://insecure' } })).toBeUndefined();
    expect(pickStoryblocksMp4(null)).toBeUndefined();
  });
});

describe('PexelsVideoAdapter', () => {
  function setup(...replies: Parameters<typeof fakeFetch>) {
    const fake = fakeFetch(...replies);
    const adapter = new PexelsVideoAdapter({ apiKey: 'px', fetchImpl: fake.fetch, now: () => NOW });
    return { adapter, requests: fake.requests };
  }

  const file = (id: number, width: number, height: number, type = 'video/mp4') => ({
    id,
    quality: 'hd',
    file_type: type,
    width,
    height,
    fps: 25,
    link: `https://videos.pexels.example/${id}.mp4`,
  });

  it('searches /v1/videos/search and returns the file closest to 1080p with credit', async () => {
    const { adapter, requests } = setup(
      json({
        page: 1,
        per_page: 15,
        total_results: 2,
        videos: [
          { id: 1, duration: 2, video_files: [file(10, 1080, 1920)] },
          {
            id: 2,
            url: 'https://www.pexels.com/video/2/',
            duration: 9,
            user: { id: 7, name: 'Ada Lens', url: 'https://www.pexels.com/@ada' },
            video_files: [
              file(20, 2160, 4096),
              file(21, 720, 1280),
              file(22, 1080, 1920),
              file(23, 1080, 1920, 'video/webm'),
            ],
          },
        ],
      }),
    );
    const submitted = await adapter.submit(request);
    const search = new URL(requests[0]!.url);
    expect(search.origin + search.pathname).toBe('https://api.pexels.com/v1/videos/search');
    expect(requests[0]!.headers.authorization).toBe('px');
    expect(Object.fromEntries(search.searchParams)).toMatchObject({
      query: 'fresh croissants bakery counter warm morning',
      orientation: 'portrait',
      size: 'medium',
    });
    expect(await adapter.poll(submitted.providerJobId)).toMatchObject({
      state: 'succeeded',
      output: {
        url: 'https://videos.pexels.example/22.mp4',
        metadata: {
          stockItemId: '2',
          licence: {
            licence: 'pexels',
            attributionRequired: false,
            creator: 'Ada Lens',
            sourcePageUrl: 'https://www.pexels.com/video/2/',
          },
          costPence: 0,
        },
      },
    });
  });

  it('fails without retry when no clip is long enough', async () => {
    const { adapter } = setup(json({ videos: [{ id: 1, duration: 1, video_files: [] }] }));
    expect(await adapter.poll((await adapter.submit(request)).providerJobId)).toMatchObject({
      state: 'failed',
      error: { class: 'invalid_request', retryable: false },
    });
  });

  it('maps HTTP failures and health', async () => {
    const { adapter } = setup(json({}, 500), json({ videos: [] }), json({}, 403));
    await expect(adapter.submit({ ...request, aspectRatio: '1:1' })).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
    });
    expect(await adapter.healthCheck()).toEqual({ healthy: true });
    expect((await adapter.healthCheck()).healthy).toBe(false);
  });

  it('ignores non-MP4, insecure and over-4K files', () => {
    expect(
      pickPexelsFile([file(1, 4320, 7680), { ...file(2, 1080, 1920), link: 'http://x' }]),
    ).toBe(undefined);
    expect(pickPexelsFile(undefined)).toBeUndefined();
  });
});
