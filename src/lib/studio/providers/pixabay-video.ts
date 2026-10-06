import { createHash } from 'node:crypto';
import type { StockSearchCache } from '../images/stock-cache';
import { STOCK_CACHE_TTL_MS } from '../images/stock-cache';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
  StockFootageRequest,
} from './interface';
import {
  classifyHttpStatus,
  classifyNetworkError,
  isOutOfCreditMessage,
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { footageKeywords, footageOrientation, type StockLicence } from './stock-footage';
import { SyncJobStore } from './sync-jobs';

// BACKLOG 22.2 — Layer 3 STOCK_FOOTAGE from Pixabay videos (production has a Pixabay key and no
// Storyblocks / Pexels key, so a wall-of-text background needs it). Contract from the Pixabay API
// documentation https://pixabay.com/api/docs/#api_search_videos (read 2026-10-06):
//   GET https://pixabay.com/api/videos/ with key (required), q ("A URL encoded search term …
//     may not exceed 100 characters"), lang, id, video_type (all | film | animation), category
//     (… backgrounds, nature, places, travel …), min_width, min_height, editors_choice,
//     safesearch (true | false, default false), order (popular | latest), page, per_page (3–200,
//     default 20). There is NO orientation parameter for videos (unlike images).
//   → { total, totalHits, hits: [{ id, pageURL, type, tags, duration, videos: { large, medium,
//       small, tiny: { url, width, height, size, thumbnail } }, views, downloads, likes,
//       comments, user_id, user, userImageURL }] }. "large … If a large video version is not
//       available, an empty URL value and a size of zero is returned."
//   "Requests must be cached for 24 hours" (the shared stock cache, images/stock-cache.ts).
//   Hotlinking: "Videos may be embedded directly … Yet, we recommend storing them on your
//     server" — the chosen file is copied into Studio's assets bucket (generate-asset.ts,
//     pipeline/persist.ts), never hotlinked.
// Error handling follows the image source (images/stock.ts): 429 rate limited, 401/403 auth,
// 5xx unavailable, HTTP 400 naming the API key = auth (observed), out-of-credit wording = an
// account problem. The provider id is `pixabay`, the kill-switch id already used for Pixabay
// images (system-flags.ts). The API is free, so a clip costs 0p.

export const PROVIDER_ID = 'pixabay';
export const PIXABAY_VIDEO_URL = 'https://pixabay.com/api/videos/';
export const PIXABAY_VIDEO_PER_PAGE = 20;
const MAX_QUERY_CHARS = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY_CHARS = 500;
/** Layer 6 renders portrait at 1080 × 1920: the smallest rendition at least this tall. */
export const TARGET_HEIGHT = 1080;
export const PIXABAY_LICENCE_URL = 'https://pixabay.com/service/license-summary/';

const RENDITIONS = ['large', 'medium', 'small', 'tiny'] as const;
type RenditionName = (typeof RENDITIONS)[number];

export interface PixabayRendition {
  url?: string;
  width?: number;
  height?: number;
  size?: number;
}

export interface PixabayVideoHit {
  id?: number;
  pageURL?: string;
  tags?: string;
  duration?: number;
  videos?: Partial<Record<RenditionName, PixabayRendition>>;
  user?: string;
  user_id?: number;
}

export interface PixabayVideoOptions {
  apiKey: string;
  cache?: StockSearchCache;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The documented search params, without the key (the key is added only to the request URL). */
export function pixabayVideoParams(request: Pick<StockFootageRequest, 'query'>): URLSearchParams {
  const q = footageKeywords(request.query).join(' ').slice(0, MAX_QUERY_CHARS);
  return new URLSearchParams({
    q,
    video_type: 'film',
    safesearch: 'true',
    per_page: String(PIXABAY_VIDEO_PER_PAGE),
  });
}

/** Cache key: a hash of the key-less params (never the API key). */
export function pixabayVideoCacheKey(params: URLSearchParams): string {
  const sorted = new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return `pixabay-video:${createHash('sha256').update(sorted.toString()).digest('hex')}`;
}

const usable = (r: PixabayRendition | undefined): r is Required<PixabayRendition> =>
  Boolean(
    r &&
    typeof r.url === 'string' &&
    r.url.startsWith('https://') &&
    typeof r.width === 'number' &&
    typeof r.height === 'number' &&
    r.width > 0 &&
    r.height > 0,
  );

/** The smallest rendition at least 1080 px tall, else the tallest one (empty large is skipped). */
export function pickPixabayRendition(
  videos: PixabayVideoHit['videos'],
): (Required<PixabayRendition> & { name: RenditionName }) | undefined {
  const all = RENDITIONS.flatMap((name) => {
    const r = videos?.[name];
    return usable(r) ? [{ ...r, name }] : [];
  });
  const tallEnough = all
    .filter((r) => r.height >= TARGET_HEIGHT)
    .sort((a, b) => a.height - b.height);
  return tallEnough[0] ?? all.sort((a, b) => b.height - a.height)[0];
}

const isPortrait = (hit: PixabayVideoHit) => {
  const r = pickPixabayRendition(hit.videos);
  return Boolean(r && r.height > r.width);
};

/**
 * Hits in the order to try: long enough for the shot (the edit does not loop clips), portrait
 * first for portrait outputs (no orientation filter exists), then Pixabay's own order.
 */
export function rankPixabayHits(
  hits: PixabayVideoHit[],
  request: Pick<StockFootageRequest, 'durationSec' | 'aspectRatio'>,
): PixabayVideoHit[] {
  const long = hits.filter((h) => h.id !== undefined && (h.duration ?? 0) >= request.durationSec);
  const wantVertical = footageOrientation(request.aspectRatio) === 'vertical';
  if (!wantVertical) return long;
  return [...long.filter(isPortrait), ...long.filter((h) => !isPortrait(h))];
}

export function classifyPixabayVideoError(status: number, body: string): ErrorClassification {
  if (status === 400 && /api key/i.test(body)) return { errorClass: 'auth', retryable: false };
  if (isOutOfCreditMessage(body)) return { errorClass: 'insufficient_credits', retryable: false };
  return classifyHttpStatus(status);
}

export class PixabayVideoAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['stock_footage'];
  readonly typicalLatencySec = 3;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: PixabayVideoOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** The Pixabay API is free. */
  estimateCostPence(_request: ProviderRequest): number {
    return 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'stock_footage')
      throw this.invalid(`Pixabay video adapter does not support ${request.capability}`);
    return {
      providerJobId: this.results.put(await this.find(request)),
      estimatedCostPence: 0,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    return this.results.get(providerJobId);
  }

  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.search(new URLSearchParams({ q: 'nature', per_page: '3', safesearch: 'true' }));
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err as Error).message };
    }
  }

  private async find(request: StockFootageRequest): Promise<ProviderPollResult> {
    const params = pixabayVideoParams(request);
    if (!params.get('q')) throw this.invalid('Scene description has no searchable words');
    const hits = await this.search(params);
    for (const hit of rankPixabayHits(hits, request)) {
      const file = pickPixabayRendition(hit.videos);
      if (!file) continue;
      const user = hit.user?.trim() || null;
      const licence: StockLicence = {
        licence: 'pixabay',
        licenceUrl: PIXABAY_LICENCE_URL,
        attributionRequired: false,
        creator: user?.slice(0, 200) ?? null,
        creatorUrl:
          user && hit.user_id !== undefined
            ? `https://pixabay.com/users/${encodeURIComponent(user)}-${hit.user_id}/`
            : null,
        sourcePageUrl: hit.pageURL ?? null,
      };
      return {
        state: 'succeeded',
        output: {
          url: file.url,
          metadata: {
            stockItemId: String(hit.id),
            rendition: file.name,
            width: file.width,
            height: file.height,
            durationSec: hit.duration ?? null,
            keywords: params.get('q'),
            licence,
            // The same credit pattern as Pixabay images (images/library.ts).
            attribution: hit.pageURL ? `Video from Pixabay: ${hit.pageURL}` : null,
            costPence: 0,
          },
        },
      };
    }
    return {
      state: 'failed',
      error: {
        class: 'invalid_request',
        message: `No Pixabay video of ${request.durationSec}s+ matched "${params.get('q')}"`,
        retryable: false,
      },
    };
  }

  private async search(params: URLSearchParams): Promise<PixabayVideoHit[]> {
    const cacheKey = pixabayVideoCacheKey(params);
    const cached = await this.options.cache?.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as PixabayVideoHit[];
      } catch {
        // A corrupt entry is refetched and overwritten below.
      }
    }
    const url = `${PIXABAY_VIDEO_URL}?${new URLSearchParams({ key: this.options.apiKey })}&${params}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), 'Pixabay request failed');
    }
    if (!res.ok) {
      // Classified only, never echoed (20.11: no raw provider text for customers).
      const text = (await res.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS);
      throw providerError(
        PROVIDER_ID,
        classifyPixabayVideoError(res.status, text),
        `Pixabay returned HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as { hits?: PixabayVideoHit[] };
    const hits = Array.isArray(body.hits) ? body.hits : [];
    await this.options.cache?.set(cacheKey, JSON.stringify(hits), STOCK_CACHE_TTL_MS);
    return hits;
  }

  private invalid(message: string) {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
