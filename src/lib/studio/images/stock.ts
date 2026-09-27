import { createHmac } from 'node:crypto';
import { ConfigurationError, ProviderError } from '../../errors';

// BACKLOG 6.4 / Addendum A6.3 Layer 2 — stock images matching the business niche.
// Shapes follow the vendors' current docs (checked 2026-09-27):
//  - Pexels   https://www.pexels.com/api/documentation/  (GET /v1/search, Authorization: <key>)
//  - Storyblocks https://documentation.storyblocks.com/ (HMAC-SHA256 over the resource path,
//    key = privateKey + EXPIRES; user_id + project_id required)
//  - Unsplash https://unsplash.com/documentation (Client-ID auth). Unsplash's API guidelines
//    REQUIRE hotlinking its URLs and forbid copying images to our own storage, so Unsplash hits
//    are marked `storable: false` and kept as hotlinks, and each use must be reported to
//    links.download_location (see trackUse).

export type StockProviderId = 'pexels' | 'storyblocks' | 'unsplash';

export interface StockHit {
  provider: StockProviderId;
  providerImageId: string;
  /** URL of the full image to download (or to hotlink, when not storable). */
  imageUrl: string;
  width: number;
  height: number;
  alt: string | null;
  pageUrl: string | null;
  attribution: { name: string; url: string | null } | null;
  /** False when the licence forbids storing a copy (Unsplash). */
  storable: boolean;
  /** Unsplash only: must be called when the image is actually used. */
  trackUseUrl?: string;
}

export interface StockSearch {
  query: string;
  perPage: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  /** Opaque ids Storyblocks requires for licence tracking (never names or emails). */
  userId: string;
  projectId: string;
}

export interface StockImageSource {
  readonly provider: StockProviderId;
  search(input: StockSearch): Promise<StockHit[]>;
  /** Resolve the download URL for a hit (Storyblocks issues it per download). */
  downloadUrl(hit: StockHit, input: Pick<StockSearch, 'userId' | 'projectId'>): Promise<string>;
}

interface Deps {
  fetchImpl: typeof fetch;
  now: () => number;
}

const TIMEOUT_MS = 20_000;

async function getJson(
  provider: StockProviderId,
  url: string,
  deps: Deps,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(provider, 'timeout', `${provider} request failed`, true, {
      cause: (err as Error).name,
    });
  }
  if (!res.ok) {
    const errorClass =
      res.status === 429
        ? 'rate_limited'
        : res.status === 401 || res.status === 403
          ? 'auth'
          : res.status >= 500
            ? 'provider_unavailable'
            : 'invalid_request';
    await res.body?.cancel();
    throw new ProviderError(
      provider,
      errorClass,
      `${provider} returned HTTP ${res.status}`,
      errorClass === 'rate_limited' || errorClass === 'provider_unavailable',
    );
  }
  return res.json() as Promise<unknown>;
}

// ---------------------------------------------------------------- Pexels

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
  alt?: string;
  src: { original: string; large2x?: string };
}

export const PEXELS_MAX_PER_PAGE = 80;

export function createPexelsSource(apiKey: string, deps: Deps): StockImageSource {
  return {
    provider: 'pexels',
    async search(input) {
      const params = new URLSearchParams({
        query: input.query,
        per_page: String(Math.min(PEXELS_MAX_PER_PAGE, Math.max(1, input.perPage))),
      });
      if (input.orientation) params.set('orientation', input.orientation);
      const body = (await getJson('pexels', `https://api.pexels.com/v1/search?${params}`, deps, {
        Authorization: apiKey,
      })) as { photos?: PexelsPhoto[] };
      return (body.photos ?? []).map((p) => ({
        provider: 'pexels' as const,
        providerImageId: String(p.id),
        imageUrl: p.src.original,
        width: p.width,
        height: p.height,
        alt: p.alt?.trim() || null,
        pageUrl: p.url,
        attribution: p.photographer
          ? { name: p.photographer, url: p.photographer_url ?? null }
          : null,
        storable: true,
      }));
    },
    async downloadUrl(hit) {
      return hit.imageUrl;
    },
  };
}

// ---------------------------------------------------------------- Storyblocks

const STORYBLOCKS_BASE = 'https://api.storyblocks.com';
export const STORYBLOCKS_MAX_PER_PAGE = 250;
/** Signatures are valid for at most 36h; we sign for 10 minutes. */
const STORYBLOCKS_EXPIRY_SEC = 600;

/** HMAC-SHA256, key = privateKey + EXPIRES, data = resource path (documentation.storyblocks.com). */
export function storyblocksAuth(
  keys: { publicKey: string; privateKey: string },
  resourcePath: string,
  nowMs: number,
): URLSearchParams {
  const expires = String(Math.floor(nowMs / 1000) + STORYBLOCKS_EXPIRY_SEC);
  const hmac = createHmac('sha256', keys.privateKey + expires)
    .update(resourcePath)
    .digest('hex');
  return new URLSearchParams({ APIKEY: keys.publicKey, EXPIRES: expires, HMAC: hmac });
}

interface StoryblocksResult {
  id: number | string;
  title?: string;
  preview_url?: string;
  thumbnail_url?: string;
}

export function createStoryblocksSource(
  keys: { publicKey: string; privateKey: string },
  deps: Deps,
): StockImageSource {
  return {
    provider: 'storyblocks',
    async search(input) {
      const path = '/api/v2/images/search';
      const params = storyblocksAuth(keys, path, deps.now());
      params.set('keywords', input.query);
      params.set('content_type', 'photos');
      params.set('safe_search', 'true');
      params.set('results_per_page', String(Math.min(STORYBLOCKS_MAX_PER_PAGE, input.perPage)));
      params.set('user_id', input.userId);
      params.set('project_id', input.projectId);
      if (input.orientation) params.set('orientation', input.orientation);
      const body = (await getJson('storyblocks', `${STORYBLOCKS_BASE}${path}?${params}`, deps)) as {
        results?: StoryblocksResult[];
      };
      // Search results carry no dimensions; the real size is read from the downloaded bytes.
      return (body.results ?? []).map((r) => ({
        provider: 'storyblocks' as const,
        providerImageId: String(r.id),
        imageUrl: r.preview_url ?? r.thumbnail_url ?? '',
        width: 0,
        height: 0,
        alt: r.title?.trim() || null,
        pageUrl: null,
        attribution: null,
        storable: true,
      }));
    },
    async downloadUrl(hit, input) {
      const path = `/api/v2/images/stock-item/download/${encodeURIComponent(hit.providerImageId)}`;
      const params = storyblocksAuth(keys, path, deps.now());
      params.set('user_id', input.userId);
      params.set('project_id', input.projectId);
      const body = (await getJson('storyblocks', `${STORYBLOCKS_BASE}${path}?${params}`, deps)) as {
        JPG?: string;
      };
      if (!body.JPG)
        throw new ProviderError('storyblocks', 'unknown', 'Storyblocks returned no JPG', false);
      return body.JPG;
    },
  };
}

// ---------------------------------------------------------------- Unsplash

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  description?: string | null;
  alt_description?: string | null;
  urls: { regular: string; full: string };
  links: { html?: string; download_location: string };
  user?: { name?: string; links?: { html?: string } };
}

export const UNSPLASH_MAX_PER_PAGE = 30;
const UNSPLASH_UTM = 'utm_source=postmind_studio&utm_medium=referral';

const withUtm = (url: string | undefined) =>
  url ? `${url}${url.includes('?') ? '&' : '?'}${UNSPLASH_UTM}` : null;

export function createUnsplashSource(accessKey: string, deps: Deps): StockImageSource {
  const headers = { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' };
  return {
    provider: 'unsplash',
    async search(input) {
      const params = new URLSearchParams({
        query: input.query,
        per_page: String(Math.min(UNSPLASH_MAX_PER_PAGE, input.perPage)),
        content_filter: 'high',
      });
      if (input.orientation)
        params.set('orientation', input.orientation === 'square' ? 'squarish' : input.orientation);
      const body = (await getJson(
        'unsplash',
        `https://api.unsplash.com/search/photos?${params}`,
        deps,
        headers,
      )) as { results?: UnsplashPhoto[] };
      return (body.results ?? []).map((p) => ({
        provider: 'unsplash' as const,
        providerImageId: p.id,
        imageUrl: p.urls.regular,
        width: p.width,
        height: p.height,
        alt: (p.alt_description ?? p.description)?.trim() || null,
        pageUrl: withUtm(p.links.html),
        attribution: p.user?.name ? { name: p.user.name, url: withUtm(p.user.links?.html) } : null,
        storable: false,
        trackUseUrl: p.links.download_location,
      }));
    },
    async downloadUrl(hit) {
      return hit.imageUrl;
    },
  };
}

/** Unsplash guideline: report each use of a photo to its download_location. */
export async function trackUnsplashUse(
  trackUseUrl: string,
  accessKey: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!trackUseUrl.startsWith('https://api.unsplash.com/')) {
    throw new ProviderError('unsplash', 'invalid_request', 'Not an Unsplash tracking URL', false);
  }
  const res = await fetchImpl(trackUseUrl, {
    headers: { Authorization: `Client-ID ${accessKey}`, 'Accept-Version': 'v1' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
}

/** Configured stock sources in priority order (A6.3: Pexels + Storyblocks primary, Unsplash fallback). */
export function stockSourcesFromEnv(
  deps: Deps,
  env: Record<string, string | undefined> = process.env,
): { primary: StockImageSource[]; fallback: StockImageSource[] } {
  const primary: StockImageSource[] = [];
  if (env.PEXELS_API_KEY) primary.push(createPexelsSource(env.PEXELS_API_KEY, deps));
  if (env.STORYBLOCKS_API_PUBLIC_KEY && env.STORYBLOCKS_API_PRIVATE_KEY) {
    primary.push(
      createStoryblocksSource(
        {
          publicKey: env.STORYBLOCKS_API_PUBLIC_KEY,
          privateKey: env.STORYBLOCKS_API_PRIVATE_KEY,
        },
        deps,
      ),
    );
  }
  const fallback = env.UNSPLASH_ACCESS_KEY
    ? [createUnsplashSource(env.UNSPLASH_ACCESS_KEY, deps)]
    : [];
  if (primary.length === 0 && fallback.length === 0) {
    throw new ConfigurationError(
      'No stock image provider configured (PEXELS_API_KEY, STORYBLOCKS_API_*_KEY or UNSPLASH_ACCESS_KEY)',
    );
  }
  return { primary, fallback };
}
