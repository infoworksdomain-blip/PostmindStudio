import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ConfigurationError, ProviderError } from '../../errors';
import { createMemoryStockCache, STOCK_CACHE_TTL_MS } from './stock-cache';
import {
  createPexelsSource,
  createPixabaySource,
  createStoryblocksSource,
  createUnsplashSource,
  PEXELS_MAX_PER_PAGE,
  PIXABAY_MAX_PER_PAGE,
  PIXABAY_MIN_PER_PAGE,
  pixabayCacheKey,
  pixabaySearchParams,
  STORYBLOCKS_MAX_PER_PAGE,
  UNSPLASH_MAX_PER_PAGE,
  stockSourcesFromEnv,
  storyblocksAuth,
  trackUnsplashUse,
  type StockSearch,
} from './stock';

const NOW_MS = 1_700_000_000_000;

function deps(fetchImpl: typeof fetch) {
  return { fetchImpl, now: () => NOW_MS };
}

const baseSearch: StockSearch = {
  query: 'sourdough bread',
  perPage: 10,
  userId: 'org-1',
  projectId: 'biz-1',
};

describe('createPexelsSource', () => {
  it('builds the search URL, sends the raw Authorization header and maps hits', async () => {
    const { fetch, requests } = fakeFetch(
      json({
        photos: [
          {
            id: 42,
            width: 1200,
            height: 800,
            url: 'https://pexels.com/photo/42',
            photographer: 'Jane Doe',
            photographer_url: 'https://pexels.com/@jane',
            alt: '  fresh bread  ',
            src: { original: 'https://images.pexels.com/42/original.jpg' },
          },
        ],
      }),
    );
    const source = createPexelsSource('pexels-key', deps(fetch));
    const hits = await source.search(baseSearch);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('expected a request');
    expect(request.url).toBe('https://api.pexels.com/v1/search?query=sourdough+bread&per_page=10');
    expect(request.headers.authorization).toBe('pexels-key');

    expect(hits).toEqual([
      {
        provider: 'pexels',
        providerImageId: '42',
        imageUrl: 'https://images.pexels.com/42/original.jpg',
        width: 1200,
        height: 800,
        alt: 'fresh bread',
        pageUrl: 'https://pexels.com/photo/42',
        attribution: { name: 'Jane Doe', url: 'https://pexels.com/@jane' },
        storable: true,
      },
    ]);
  });

  it('caps per_page at PEXELS_MAX_PER_PAGE and floors it at 1', async () => {
    const over = fakeFetch(json({ photos: [] }));
    await createPexelsSource('k', deps(over.fetch)).search({ ...baseSearch, perPage: 999 });
    expect(over.requests[0]?.url).toContain(`per_page=${PEXELS_MAX_PER_PAGE}`);

    const under = fakeFetch(json({ photos: [] }));
    await createPexelsSource('k', deps(under.fetch)).search({ ...baseSearch, perPage: -5 });
    expect(under.requests[0]?.url).toContain('per_page=1');
  });

  it('sets the orientation param only when provided', async () => {
    const { fetch, requests } = fakeFetch(json({ photos: [] }), json({ photos: [] }));
    const source = createPexelsSource('k', deps(fetch));
    await source.search({ ...baseSearch, orientation: 'landscape' });
    await source.search(baseSearch);
    expect(requests[0]?.url).toContain('orientation=landscape');
    expect(requests[1]?.url).not.toContain('orientation');
  });

  it('falls back to a null alt and null attribution when absent', async () => {
    const { fetch } = fakeFetch(
      json({
        photos: [
          {
            id: 1,
            width: 10,
            height: 10,
            url: 'https://pexels.com/photo/1',
            src: { original: 'https://images.pexels.com/1/original.jpg' },
          },
        ],
      }),
    );
    const [hit] = await createPexelsSource('k', deps(fetch)).search(baseSearch);
    expect(hit?.alt).toBeNull();
    expect(hit?.attribution).toBeNull();
  });

  it('downloadUrl returns the hit image URL directly (no signing needed)', async () => {
    const source = createPexelsSource('k', deps(fakeFetch().fetch));
    const hit = {
      provider: 'pexels' as const,
      providerImageId: '1',
      imageUrl: 'https://images.pexels.com/1/original.jpg',
      width: 10,
      height: 10,
      alt: null,
      pageUrl: null,
      attribution: null,
      storable: true,
    };
    await expect(source.downloadUrl(hit, baseSearch)).resolves.toBe(hit.imageUrl);
  });
});

describe('storyblocksAuth', () => {
  it('computes EXPIRES as now/1000 + 600 and an HMAC-SHA256 over the resource path', () => {
    const keys = { publicKey: 'pub-key', privateKey: 'priv-key' };
    const path = '/api/v2/images/search';
    const params = storyblocksAuth(keys, path, NOW_MS);

    const expectedExpires = String(Math.floor(NOW_MS / 1000) + 600);
    expect(params.get('EXPIRES')).toBe(expectedExpires);
    expect(params.get('APIKEY')).toBe('pub-key');

    const expectedHmac = createHmac('sha256', keys.privateKey + expectedExpires)
      .update(path)
      .digest('hex');
    expect(params.get('HMAC')).toBe(expectedHmac);
  });

  it('produces a different HMAC for a different resource path with the same keys/time', () => {
    const keys = { publicKey: 'pub', privateKey: 'priv' };
    const a = storyblocksAuth(keys, '/a', NOW_MS).get('HMAC');
    const b = storyblocksAuth(keys, '/b', NOW_MS).get('HMAC');
    expect(a).not.toBe(b);
  });
});

describe('createStoryblocksSource', () => {
  const keys = { publicKey: 'pub-key', privateKey: 'priv-key' };

  it('sends the documented search params, capped results_per_page and orientation', async () => {
    const { fetch, requests } = fakeFetch(json({ results: [] }));
    const source = createStoryblocksSource(keys, deps(fetch));
    await source.search({ ...baseSearch, perPage: 999, orientation: 'portrait' });

    const request = requests[0];
    if (!request) throw new Error('expected a request');
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/v2/images/search');
    expect(url.searchParams.get('keywords')).toBe('sourdough bread');
    expect(url.searchParams.get('content_type')).toBe('photos');
    expect(url.searchParams.get('safe_search')).toBe('true');
    expect(url.searchParams.get('results_per_page')).toBe(String(STORYBLOCKS_MAX_PER_PAGE));
    expect(url.searchParams.get('user_id')).toBe('org-1');
    expect(url.searchParams.get('project_id')).toBe('biz-1');
    expect(url.searchParams.get('orientation')).toBe('portrait');
    expect(url.searchParams.get('APIKEY')).toBe('pub-key');
    expect(url.searchParams.get('EXPIRES')).toBeTruthy();
    expect(url.searchParams.get('HMAC')).toBeTruthy();
  });

  it('does not cap results_per_page below the requested value', async () => {
    const { fetch, requests } = fakeFetch(json({ results: [] }));
    await createStoryblocksSource(keys, deps(fetch)).search({ ...baseSearch, perPage: 12 });
    expect(new URL(requests[0]?.url ?? '').searchParams.get('results_per_page')).toBe('12');
  });

  it('maps results with zero dimensions (real size comes from the downloaded bytes)', async () => {
    const { fetch } = fakeFetch(
      json({
        results: [{ id: 7, title: '  loaf  ', preview_url: 'https://sb.example/7.jpg' }],
      }),
    );
    const [hit] = await createStoryblocksSource(keys, deps(fetch)).search(baseSearch);
    expect(hit).toEqual({
      provider: 'storyblocks',
      providerImageId: '7',
      imageUrl: 'https://sb.example/7.jpg',
      width: 0,
      height: 0,
      alt: 'loaf',
      pageUrl: null,
      attribution: null,
      storable: true,
    });
  });

  it('falls back to thumbnail_url and an empty string, and a null alt when absent', async () => {
    const { fetch } = fakeFetch(
      json({ results: [{ id: 8, thumbnail_url: 'https://sb.example/8-thumb.jpg' }] }),
    );
    const [hit] = await createStoryblocksSource(keys, deps(fetch)).search(baseSearch);
    expect(hit?.imageUrl).toBe('https://sb.example/8-thumb.jpg');
    expect(hit?.alt).toBeNull();

    const { fetch: fetch2 } = fakeFetch(json({ results: [{ id: 9 }] }));
    const [hit2] = await createStoryblocksSource(keys, deps(fetch2)).search(baseSearch);
    expect(hit2?.imageUrl).toBe('');
  });

  it('downloadUrl signs the stock-item download path and returns the JPG URL', async () => {
    const { fetch, requests } = fakeFetch(json({ JPG: 'https://sb.example/download/7.jpg' }));
    const source = createStoryblocksSource(keys, deps(fetch));
    const hit = {
      provider: 'storyblocks' as const,
      providerImageId: '7',
      imageUrl: '',
      width: 0,
      height: 0,
      alt: null,
      pageUrl: null,
      attribution: null,
      storable: true,
    };
    const url = await source.downloadUrl(hit, { userId: 'org-1', projectId: 'biz-1' });
    expect(url).toBe('https://sb.example/download/7.jpg');

    const request = requests[0];
    if (!request) throw new Error('expected a request');
    const parsed = new URL(request.url);
    expect(parsed.pathname).toBe('/api/v2/images/stock-item/download/7');
    expect(parsed.searchParams.get('user_id')).toBe('org-1');
    expect(parsed.searchParams.get('project_id')).toBe('biz-1');
    expect(parsed.searchParams.get('HMAC')).toBeTruthy();
  });

  it('downloadUrl throws a ProviderError when Storyblocks returns no JPG', async () => {
    const { fetch } = fakeFetch(json({}));
    const source = createStoryblocksSource(keys, deps(fetch));
    const hit = {
      provider: 'storyblocks' as const,
      providerImageId: '7',
      imageUrl: '',
      width: 0,
      height: 0,
      alt: null,
      pageUrl: null,
      attribution: null,
      storable: true,
    };
    await expect(source.downloadUrl(hit, { userId: 'o', projectId: 'p' })).rejects.toMatchObject({
      providerId: 'storyblocks',
      errorClass: 'unknown',
      retryable: false,
    });
  });
});

describe('createUnsplashSource', () => {
  it('sends Client-ID and Accept-Version headers and caps per_page at UNSPLASH_MAX_PER_PAGE', async () => {
    const { fetch, requests } = fakeFetch(json({ results: [] }));
    await createUnsplashSource('access-key', deps(fetch)).search({ ...baseSearch, perPage: 999 });
    const request = requests[0];
    if (!request) throw new Error('expected a request');
    expect(request.headers.authorization).toBe('Client-ID access-key');
    expect(request.headers['accept-version']).toBe('v1');
    const url = new URL(request.url);
    expect(url.searchParams.get('per_page')).toBe(String(UNSPLASH_MAX_PER_PAGE));
    expect(url.searchParams.get('content_filter')).toBe('high');
  });

  it('maps "square" orientation to Unsplash\'s "squarish" but passes others through', async () => {
    const { fetch, requests } = fakeFetch(json({ results: [] }), json({ results: [] }));
    const source = createUnsplashSource('k', deps(fetch));
    await source.search({ ...baseSearch, orientation: 'square' });
    await source.search({ ...baseSearch, orientation: 'landscape' });
    expect(new URL(requests[0]?.url ?? '').searchParams.get('orientation')).toBe('squarish');
    expect(new URL(requests[1]?.url ?? '').searchParams.get('orientation')).toBe('landscape');
  });

  it('maps hits as non-storable with a trackUseUrl and utm-tagged attribution links', async () => {
    const { fetch } = fakeFetch(
      json({
        results: [
          {
            id: 'abc',
            width: 1600,
            height: 900,
            alt_description: '  loaf of bread  ',
            urls: { regular: 'https://images.unsplash.com/abc?w=1080', full: 'https://x' },
            links: {
              html: 'https://unsplash.com/photos/abc',
              download_location: 'https://api.unsplash.com/photos/abc/download',
            },
            user: { name: 'Jamie', links: { html: 'https://unsplash.com/@jamie' } },
          },
        ],
      }),
    );
    const [hit] = await createUnsplashSource('k', deps(fetch)).search(baseSearch);
    expect(hit).toMatchObject({
      provider: 'unsplash',
      providerImageId: 'abc',
      imageUrl: 'https://images.unsplash.com/abc?w=1080',
      width: 1600,
      height: 900,
      alt: 'loaf of bread',
      storable: false,
      trackUseUrl: 'https://api.unsplash.com/photos/abc/download',
    });
    expect(hit?.pageUrl).toBe(
      'https://unsplash.com/photos/abc?utm_source=postmind_studio&utm_medium=referral',
    );
    expect(hit?.attribution).toEqual({
      name: 'Jamie',
      url: 'https://unsplash.com/@jamie?utm_source=postmind_studio&utm_medium=referral',
    });
  });

  it('falls back to description, then null alt and null attribution', async () => {
    const { fetch } = fakeFetch(
      json({
        results: [
          {
            id: 'x',
            width: 10,
            height: 10,
            description: 'a bakery',
            urls: { regular: 'https://images.unsplash.com/x', full: 'https://x' },
            links: {
              download_location: 'https://api.unsplash.com/photos/x/download',
            },
          },
        ],
      }),
    );
    const [hit] = await createUnsplashSource('k', deps(fetch)).search(baseSearch);
    expect(hit?.alt).toBe('a bakery');
    expect(hit?.pageUrl).toBeNull();
    expect(hit?.attribution).toBeNull();
  });

  it('downloadUrl returns the hit image URL directly', async () => {
    const source = createUnsplashSource('k', deps(fakeFetch().fetch));
    const hit = {
      provider: 'unsplash' as const,
      providerImageId: 'abc',
      imageUrl: 'https://images.unsplash.com/abc',
      width: 10,
      height: 10,
      alt: null,
      pageUrl: null,
      attribution: null,
      storable: false,
    };
    await expect(source.downloadUrl(hit, baseSearch)).resolves.toBe(hit.imageUrl);
  });
});

describe('HTTP error mapping (shared by every source)', () => {
  it('maps 429 to rate_limited and retryable', async () => {
    const { fetch } = fakeFetch(json({}, 429));
    await expect(createPexelsSource('k', deps(fetch)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
    });
  });

  it('maps 401 and 403 to auth and non-retryable', async () => {
    const { fetch } = fakeFetch(json({}, 401));
    await expect(createPexelsSource('k', deps(fetch)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'auth',
      retryable: false,
    });
    const { fetch: fetch403 } = fakeFetch(json({}, 403));
    await expect(createPexelsSource('k', deps(fetch403)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'auth',
      retryable: false,
    });
  });

  it('maps 5xx to provider_unavailable and retryable', async () => {
    const { fetch } = fakeFetch(json({}, 500));
    await expect(createPexelsSource('k', deps(fetch)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });

  it('maps other 4xx to invalid_request and non-retryable', async () => {
    const { fetch } = fakeFetch(json({}, 400));
    await expect(createPexelsSource('k', deps(fetch)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
  });

  it('maps a network failure to timeout and retryable', async () => {
    const { fetch } = fakeFetch(new Error('ECONNRESET'));
    await expect(createPexelsSource('k', deps(fetch)).search(baseSearch)).rejects.toBeInstanceOf(
      ProviderError,
    );
    const { fetch: fetch2 } = fakeFetch(new Error('ECONNRESET'));
    await expect(createPexelsSource('k', deps(fetch2)).search(baseSearch)).rejects.toMatchObject({
      errorClass: 'timeout',
      retryable: true,
    });
  });
});

describe('trackUnsplashUse', () => {
  it('reports use to the given download_location with Client-ID auth', async () => {
    const { fetch, requests } = fakeFetch(json({}));
    await trackUnsplashUse('https://api.unsplash.com/photos/abc/download', 'access-key', fetch);
    const request = requests[0];
    if (!request) throw new Error('expected a request');
    expect(request.url).toBe('https://api.unsplash.com/photos/abc/download');
    expect(request.headers.authorization).toBe('Client-ID access-key');
    expect(request.headers['accept-version']).toBe('v1');
  });

  it('refuses a URL that is not on api.unsplash.com', async () => {
    const { fetch, requests } = fakeFetch();
    await expect(
      trackUnsplashUse('https://evil.example/photos/abc/download', 'k', fetch),
    ).rejects.toMatchObject({ providerId: 'unsplash', errorClass: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
});

describe('stockSourcesFromEnv', () => {
  it('orders Pexels then Storyblocks as primary, Unsplash as fallback', () => {
    const { primary, fallback } = stockSourcesFromEnv(deps(fakeFetch().fetch), {
      PEXELS_API_KEY: 'p',
      STORYBLOCKS_API_PUBLIC_KEY: 'pub',
      STORYBLOCKS_API_PRIVATE_KEY: 'priv',
      UNSPLASH_ACCESS_KEY: 'u',
    } as unknown as NodeJS.ProcessEnv);
    expect(primary.map((s) => s.provider)).toEqual(['pexels', 'storyblocks']);
    expect(fallback.map((s) => s.provider)).toEqual(['unsplash']);
  });

  it('20.16: Pixabay is the last primary (after Pexels and Storyblocks); Unsplash stays fallback', () => {
    const { primary, fallback } = stockSourcesFromEnv(deps(fakeFetch().fetch), {
      PEXELS_API_KEY: 'p',
      STORYBLOCKS_API_PUBLIC_KEY: 'pub',
      STORYBLOCKS_API_PRIVATE_KEY: 'priv',
      PIXABAY_API_KEY: 'x',
      UNSPLASH_ACCESS_KEY: 'u',
    } as unknown as NodeJS.ProcessEnv);
    expect(primary.map((s) => s.provider)).toEqual(['pexels', 'storyblocks', 'pixabay']);
    expect(fallback.map((s) => s.provider)).toEqual(['unsplash']);
  });

  it('20.16: Pixabay alone is enough; a blank PIXABAY_API_KEY is not configured', () => {
    const { primary } = stockSourcesFromEnv(deps(fakeFetch().fetch), {
      PIXABAY_API_KEY: 'x',
    } as unknown as NodeJS.ProcessEnv);
    expect(primary.map((s) => s.provider)).toEqual(['pixabay']);
    expect(() =>
      stockSourcesFromEnv(deps(fakeFetch().fetch), {
        PIXABAY_API_KEY: '  ',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/PIXABAY_API_KEY/);
  });

  it('omits Storyblocks when only one of its two keys is set, alongside a configured Pexels', () => {
    const { primary, fallback } = stockSourcesFromEnv(deps(fakeFetch().fetch), {
      PEXELS_API_KEY: 'p',
      STORYBLOCKS_API_PUBLIC_KEY: 'pub',
    } as unknown as NodeJS.ProcessEnv);
    expect(primary.map((s) => s.provider)).toEqual(['pexels']);
    expect(fallback).toEqual([]);
  });

  it('throws ConfigurationError when no provider is configured', () => {
    expect(() =>
      stockSourcesFromEnv(deps(fakeFetch().fetch), {} as unknown as NodeJS.ProcessEnv),
    ).toThrow(ConfigurationError);
  });

  it('returns only the fallback when only Unsplash is configured', () => {
    const { primary, fallback } = stockSourcesFromEnv(deps(fakeFetch().fetch), {
      UNSPLASH_ACCESS_KEY: 'u',
    } as unknown as NodeJS.ProcessEnv);
    expect(primary).toEqual([]);
    expect(fallback.map((s) => s.provider)).toEqual(['unsplash']);
  });
});

// 20.16 — Pixabay (https://pixabay.com/api/docs/, read 2026-10-01). Responses are mocked.
const PIXABAY_HIT = {
  id: 195893,
  pageURL: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
  type: 'photo',
  tags: '  blossom, bloom, flower  ',
  previewURL: 'https://cdn.pixabay.com/photo/2013/10/15/09/12/flower-195893_150.jpg',
  webformatURL: 'https://pixabay.com/get/35bbf209e13e39d2_640.jpg',
  largeImageURL: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
  imageWidth: 4000,
  imageHeight: 2250,
  user_id: 48777,
  user: 'Josch13',
};

describe('createPixabaySource', () => {
  it('builds the documented request: key, q, image_type=photo, safesearch=true, per_page', async () => {
    const { fetch, requests } = fakeFetch(json({ total: 1, totalHits: 1, hits: [] }));
    await createPixabaySource('pixabay-key', deps(fetch)).search({
      ...baseSearch,
      orientation: 'landscape',
    });
    const url = new URL(requests[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://pixabay.com/api/');
    expect(url.searchParams.get('key')).toBe('pixabay-key');
    expect(url.searchParams.get('q')).toBe('sourdough bread');
    expect(url.searchParams.get('image_type')).toBe('photo');
    expect(url.searchParams.get('safesearch')).toBe('true');
    expect(url.searchParams.get('per_page')).toBe('10');
    expect(url.searchParams.get('orientation')).toBe('horizontal');
    expect(url.searchParams.has('min_width')).toBe(false);
    // The key travels in the query string only: no auth header.
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('maps orientation (portrait → vertical, square → no filter) and passes min_width', () => {
    expect(pixabaySearchParams({ ...baseSearch, orientation: 'portrait' }).get('orientation')).toBe(
      'vertical',
    );
    expect(pixabaySearchParams({ ...baseSearch, orientation: 'square' }).has('orientation')).toBe(
      false,
    );
    expect(pixabaySearchParams({ ...baseSearch, minWidth: 1080.6 }).get('min_width')).toBe('1080');
  });

  it('clamps per_page to the documented 3-200 and q to 100 characters', () => {
    expect(pixabaySearchParams({ ...baseSearch, perPage: 1 }).get('per_page')).toBe(
      String(PIXABAY_MIN_PER_PAGE),
    );
    expect(pixabaySearchParams({ ...baseSearch, perPage: 999 }).get('per_page')).toBe(
      String(PIXABAY_MAX_PER_PAGE),
    );
    expect(pixabaySearchParams({ ...baseSearch, query: 'a'.repeat(150) }).get('q')).toHaveLength(
      100,
    );
  });

  it('maps a hit: 1280 px largeImageURL by default, storable, Pixabay user + page attribution', async () => {
    const { fetch } = fakeFetch(json({ total: 1, totalHits: 1, hits: [PIXABAY_HIT] }));
    const [hit] = await createPixabaySource('k', deps(fetch)).search(baseSearch);
    expect(hit).toEqual({
      provider: 'pixabay',
      providerImageId: '195893',
      imageUrl: 'https://pixabay.com/get/ed6a99fd0a76647_1280.jpg',
      width: 1280,
      height: 720,
      alt: 'blossom, bloom, flower',
      pageUrl: 'https://pixabay.com/en/blossom-bloom-flower-195893/',
      attribution: { name: 'Josch13', url: 'https://pixabay.com/users/Josch13-48777/' },
      storable: true,
    });
    // Never the 150 px search preview: that URL is only for transient display on Pixabay's terms.
    expect(hit?.imageUrl).not.toBe(PIXABAY_HIT.previewURL);
  });

  it('uses the 640 px webformatURL when the caller needs at most 640 px', async () => {
    const { fetch } = fakeFetch(json({ hits: [PIXABAY_HIT] }));
    const [hit] = await createPixabaySource('k', deps(fetch)).search({
      ...baseSearch,
      minWidth: 600,
    });
    expect(hit).toMatchObject({ imageUrl: PIXABAY_HIT.webformatURL, width: 640, height: 360 });
  });

  it('falls back to webformatURL without largeImageURL, and skips hits with neither', async () => {
    const { fetch } = fakeFetch(
      json({
        hits: [
          {
            id: 1,
            webformatURL: 'https://pixabay.com/get/a_640.jpg',
            imageWidth: 300,
            imageHeight: 200,
          },
          { id: 2, pageURL: 'https://pixabay.com/x-2/' },
        ],
      }),
    );
    const hits = await createPixabaySource('k', deps(fetch)).search(baseSearch);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      imageUrl: 'https://pixabay.com/get/a_640.jpg',
      width: 300,
      height: 200,
      alt: null,
      pageUrl: null,
      attribution: null,
    });
  });

  it('downloadUrl returns the chosen image URL (downloaded into our storage, never hotlinked)', async () => {
    const { fetch } = fakeFetch(json({ hits: [PIXABAY_HIT] }));
    const source = createPixabaySource('k', deps(fetch));
    const [hit] = await source.search(baseSearch);
    if (!hit) throw new Error('expected a hit');
    await expect(source.downloadUrl(hit, baseSearch)).resolves.toBe(PIXABAY_HIT.largeImageURL);
  });

  it('answers a repeated search from the 24 h cache without a second request', async () => {
    let t = NOW_MS;
    const cache = createMemoryStockCache({ now: () => t });
    const { fetch, requests } = fakeFetch(json({ hits: [PIXABAY_HIT] }), json({ hits: [] }));
    const source = createPixabaySource('k', { fetchImpl: fetch, now: () => t, cache });
    const first = await source.search(baseSearch);
    t += STOCK_CACHE_TTL_MS - 1;
    const second = await source.search(baseSearch);
    expect(requests).toHaveLength(1);
    expect(second).toEqual(first);
    t += 1; // 24 h later the entry has expired
    await expect(source.search(baseSearch)).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('keys the cache by query and params, never by the API key', async () => {
    const cache = createMemoryStockCache();
    const { fetch, requests } = fakeFetch(json({ hits: [PIXABAY_HIT] }), json({ hits: [] }));
    await createPixabaySource('key-one', { ...deps(fetch), cache }).search(baseSearch);
    // Another key, same search: served from the cache (the key is not part of the cache key).
    await createPixabaySource('key-two', { ...deps(fetch), cache }).search(baseSearch);
    expect(requests).toHaveLength(1);
    await createPixabaySource('key-one', { ...deps(fetch), cache }).search({
      ...baseSearch,
      orientation: 'portrait',
    });
    expect(requests).toHaveLength(2);

    const key = pixabayCacheKey(pixabaySearchParams(baseSearch));
    expect(key).toMatch(/^pixabay:[0-9a-f]{64}$/);
    expect(key).not.toContain('key-one');
    // Param order does not change the key.
    const reordered = new URLSearchParams([...pixabaySearchParams(baseSearch).entries()].reverse());
    expect(pixabayCacheKey(reordered)).toBe(key);
  });

  it('refetches over a corrupt cache entry', async () => {
    const cache = createMemoryStockCache();
    await cache.set(pixabayCacheKey(pixabaySearchParams(baseSearch)), '{not json', 60_000);
    const { fetch, requests } = fakeFetch(json({ hits: [PIXABAY_HIT] }));
    const hits = await createPixabaySource('k', { ...deps(fetch), cache }).search(baseSearch);
    expect(requests).toHaveLength(1);
    expect(hits).toHaveLength(1);
  });

  it('does not cache a failed request', async () => {
    const cache = createMemoryStockCache();
    const { fetch, requests } = fakeFetch(
      new Response('API rate limit exceeded', { status: 429 }),
      json({ hits: [PIXABAY_HIT] }),
    );
    const source = createPixabaySource('k', { ...deps(fetch), cache });
    await expect(source.search(baseSearch)).rejects.toBeInstanceOf(ProviderError);
    await expect(source.search(baseSearch)).resolves.toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it('maps 429 to rate_limited (retryable) without echoing the provider text', async () => {
    const { fetch } = fakeFetch(new Response('API rate limit exceeded', { status: 429 }));
    const err = await createPixabaySource('k', deps(fetch))
      .search(baseSearch)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      providerId: 'pixabay',
      errorClass: 'rate_limited',
      retryable: true,
    });
    expect((err as Error).message).not.toContain('API rate limit exceeded');
  });

  it('maps 401/403 and a 400 naming the API key to auth (20.11 account error, not retried)', async () => {
    for (const reply of [
      new Response('', { status: 401 }),
      new Response('', { status: 403 }),
      new Response('[ERROR 400] Invalid or missing API key', { status: 400 }),
    ]) {
      const { fetch } = fakeFetch(reply);
      await expect(createPixabaySource('k', deps(fetch)).search(baseSearch)).rejects.toMatchObject({
        providerId: 'pixabay',
        errorClass: 'auth',
        retryable: false,
      });
    }
  });

  it('keeps any other 400 as invalid_request and 5xx as provider_unavailable', async () => {
    const bad = fakeFetch(
      new Response('[ERROR 400] "per_page" is out of valid range.', { status: 400 }),
    );
    await expect(
      createPixabaySource('k', deps(bad.fetch)).search(baseSearch),
    ).rejects.toMatchObject({
      errorClass: 'invalid_request',
    });
    const down = fakeFetch(new Response('', { status: 503 }));
    await expect(
      createPixabaySource('k', deps(down.fetch)).search(baseSearch),
    ).rejects.toMatchObject({
      errorClass: 'provider_unavailable',
      retryable: true,
    });
  });
});
