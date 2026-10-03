import { createHash, createHmac } from 'node:crypto';
import { ConfigurationError, ProviderError } from '../../errors';
import { STOCK_CACHE_TTL_MS, type StockSearchCache } from './stock-cache';

// BACKLOG 6.4 / Addendum A6.3 Layer 2 — stock images matching the business niche.
// Shapes follow the vendors' current docs (checked 2026-09-27):
//  - Pexels   https://www.pexels.com/api/documentation/  (GET /v1/search, Authorization: <key>)
//  - Storyblocks https://documentation.storyblocks.com/ (HMAC-SHA256 over the resource path,
//    key = privateKey + EXPIRES; user_id + project_id required)
//  - Unsplash https://unsplash.com/documentation (Client-ID auth). Unsplash's API guidelines
//    REQUIRE hotlinking its URLs and forbid copying images to our own storage, so Unsplash hits
//    are marked `storable: false` and kept as hotlinks, and each use must be reported to
//    links.download_location (see trackUse).
//  - Pixabay  https://pixabay.com/api/docs/ (read 2026-10-01; GET https://pixabay.com/api/?key=...).
//    The terms forbid permanent hotlinking ("If you intend to use the images, please download
//    them to your server first"), require responses to be cached for 24 hours, and require
//    showing users where images come from whenever search results are displayed. Pixabay hits
//    are therefore `storable: true` (copied into our storage like Pexels) and searches go through
//    a 24 h cache (stock-cache.ts).

export type StockProviderId = 'pexels' | 'storyblocks' | 'unsplash' | 'pixabay';

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
  /**
   * Smallest useful width in px. Pixabay uses it for `min_width` and to pick its 640 px
   * webformatURL instead of the 1280 px largeImageURL; other sources ignore it.
   */
  minWidth?: number;
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
  /** Search-response cache (required by Pixabay's terms; other sources do not use it). */
  cache?: StockSearchCache;
}

const TIMEOUT_MS = 20_000;

/** Optional per-provider refinement of an HTTP error class from the response's text body. */
type ErrorBodyClassifier = (status: number, body: string) => string | null;

const MAX_ERROR_BODY_CHARS = 500;

function errorClassForStatus(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_request';
}

async function getJson(
  provider: StockProviderId,
  url: string,
  deps: Deps,
  headers: Record<string, string> = {},
  classifyBody?: ErrorBodyClassifier,
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
    let errorClass = errorClassForStatus(res.status);
    if (classifyBody) {
      // The body is only classified, never echoed (20.11: no raw provider text for customers).
      const text = (await res.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS);
      errorClass = classifyBody(res.status, text) ?? errorClass;
    } else {
      await res.body?.cancel();
    }
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

// ---------------------------------------------------------------- Pixabay

// https://pixabay.com/api/docs/ (read 2026-10-01): GET https://pixabay.com/api/ with key, q
// ("Max 100 characters"), image_type (all|photo|illustration|vector), orientation
// (all|horizontal|vertical), safesearch, per_page (3-200, default 20), min_width, min_height,
// order, page, lang. Hits: id, pageURL, tags, previewURL (150 px), webformatURL (640 px, "URL
// valid for 24 hours"), largeImageURL ("Scaled image with a maximum width/height of 1280px"),
// imageWidth/imageHeight (the original's size), user, user_id; profile pages are
// https://pixabay.com/users/{USERNAME}-{ID}/. fullHDURL / imageURL need full API access and are
// not used. Rate limit: 100 requests per 60 s per key, HTTP 429 when exceeded.

const PIXABAY_API_URL = 'https://pixabay.com/api/';
export const PIXABAY_MIN_PER_PAGE = 3;
export const PIXABAY_MAX_PER_PAGE = 200;
export const PIXABAY_MAX_QUERY_CHARS = 100;
export const PIXABAY_WEBFORMAT_MAX_PX = 640;
export const PIXABAY_LARGE_MAX_PX = 1280;
export const PIXABAY_LICENCE_URL = 'https://pixabay.com/service/license-summary/';

const PIXABAY_ORIENTATION: Record<NonNullable<StockSearch['orientation']>, string | null> = {
  landscape: 'horizontal',
  portrait: 'vertical',
  square: null, // Pixabay has no square filter: "all"
};

interface PixabayImage {
  id: number;
  pageURL?: string;
  tags?: string;
  webformatURL?: string;
  largeImageURL?: string;
  imageWidth?: number;
  imageHeight?: number;
  user?: string;
  user_id?: number;
}

/** The documented search params without the key (the key is added only to the request URL). */
export function pixabaySearchParams(input: StockSearch): URLSearchParams {
  const perPage = Math.floor(input.perPage);
  const params = new URLSearchParams({
    q: input.query.trim().slice(0, PIXABAY_MAX_QUERY_CHARS),
    image_type: 'photo',
    safesearch: 'true',
    per_page: String(Math.min(PIXABAY_MAX_PER_PAGE, Math.max(PIXABAY_MIN_PER_PAGE, perPage))),
  });
  const orientation = input.orientation ? PIXABAY_ORIENTATION[input.orientation] : null;
  if (orientation) params.set('orientation', orientation);
  if (input.minWidth && input.minWidth > 0) {
    params.set('min_width', String(Math.floor(input.minWidth)));
  }
  return params;
}

/** Cache key: provider + a hash of the key-less params (never the API key itself). */
export function pixabayCacheKey(params: URLSearchParams): string {
  const sorted = new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return `pixabay:${createHash('sha256').update(sorted.toString()).digest('hex')}`;
}

/**
 * Pixabay documents only the 429 error ("HTTP error status codes with plain text descriptions").
 * An invalid or missing key is answered with HTTP 400 whose text names the API key (observed,
 * not documented), which is an account problem (20.11 `auth`), not a bad request.
 */
const classifyPixabayError: ErrorBodyClassifier = (status, body) =>
  status === 400 && /api key/i.test(body) ? 'auth' : null;

function scaledSize(width: number, height: number, maxPx: number) {
  const scale = Math.min(1, maxPx / Math.max(width, height, 1));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function pixabayAttribution(image: PixabayImage): StockHit['attribution'] {
  const user = image.user?.trim();
  if (!user) return null;
  const url =
    image.user_id !== undefined
      ? `https://pixabay.com/users/${encodeURIComponent(user)}-${image.user_id}/`
      : null;
  return { name: user, url };
}

function mapPixabayImage(image: PixabayImage, minWidth: number | undefined): StockHit | null {
  // The 640 px webformatURL is enough when the caller needs at most that width; else 1280 px.
  const medium = Boolean(minWidth && minWidth <= PIXABAY_WEBFORMAT_MAX_PX && image.webformatURL);
  const useLarge = !medium && Boolean(image.largeImageURL);
  const imageUrl = useLarge ? image.largeImageURL : image.webformatURL;
  if (!imageUrl) return null;
  const maxPx = useLarge ? PIXABAY_LARGE_MAX_PX : PIXABAY_WEBFORMAT_MAX_PX;
  return {
    provider: 'pixabay',
    providerImageId: String(image.id),
    imageUrl,
    ...scaledSize(image.imageWidth ?? 0, image.imageHeight ?? 0, maxPx),
    alt: image.tags?.trim() || null,
    pageUrl: image.pageURL ?? null,
    attribution: pixabayAttribution(image),
    // Never hotlinked: the image is downloaded into our storage before use (Pixabay's terms).
    storable: true,
  };
}

async function pixabayHits(
  apiKey: string,
  params: URLSearchParams,
  deps: Deps,
): Promise<PixabayImage[]> {
  const cacheKey = pixabayCacheKey(params);
  const cached = await deps.cache?.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as PixabayImage[];
    } catch {
      // A corrupt entry is refetched and overwritten below.
    }
  }
  const url = `${PIXABAY_API_URL}?${new URLSearchParams({ key: apiKey })}&${params}`;
  const body = (await getJson('pixabay', url, deps, {}, classifyPixabayError)) as {
    hits?: PixabayImage[];
  };
  const hits = body.hits ?? [];
  await deps.cache?.set(cacheKey, JSON.stringify(hits), STOCK_CACHE_TTL_MS);
  return hits;
}

export function createPixabaySource(apiKey: string, deps: Deps): StockImageSource {
  return {
    provider: 'pixabay',
    async search(input) {
      const hits = await pixabayHits(apiKey, pixabaySearchParams(input), deps);
      return hits
        .map((image) => mapPixabayImage(image, input.minWidth))
        .filter((hit): hit is StockHit => hit !== null);
    },
    async downloadUrl(hit) {
      return hit.imageUrl;
    },
  };
}

/**
 * Configured stock sources in priority order (A6.3: Pexels + Storyblocks primary, Unsplash
 * fallback; 20.16: Pixabay is the last primary, after the existing ones).
 */
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
  const pixabayKey = env.PIXABAY_API_KEY?.trim();
  if (pixabayKey) primary.push(createPixabaySource(pixabayKey, deps));
  const fallback = env.UNSPLASH_ACCESS_KEY
    ? [createUnsplashSource(env.UNSPLASH_ACCESS_KEY, deps)]
    : [];
  if (primary.length === 0 && fallback.length === 0) {
    throw new ConfigurationError(
      'No stock image provider configured: set PIXABAY_API_KEY (free), PEXELS_API_KEY, STORYBLOCKS_API_PUBLIC_KEY + STORYBLOCKS_API_PRIVATE_KEY or UNSPLASH_ACCESS_KEY',
    );
  }
  return { primary, fallback };
}
