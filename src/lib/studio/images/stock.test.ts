import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { ConfigurationError, ProviderError } from '../../errors';
import {
  createPexelsSource,
  createStoryblocksSource,
  createUnsplashSource,
  PEXELS_MAX_PER_PAGE,
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
