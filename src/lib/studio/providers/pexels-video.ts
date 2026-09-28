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
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { footageKeywords, footageOrientation, type StockLicence } from './stock-footage';
import { SyncJobStore } from './sync-jobs';

// Phase 15 (register 13.38 correction) — Layer 3 STOCK_FOOTAGE fallback from Pexels videos
// (spec 6.4 STOCK_FOOTAGE: "storyblocks, pexels"). Contract from the Pexels API documentation
// https://www.pexels.com/api/documentation/#videos-search (read 2026-09-28):
//   GET https://api.pexels.com/v1/videos/search?query&orientation&size&per_page   (Authorization: <key>)
//     ("Video endpoints are now available at https://api.pexels.com/v1/videos/"; per_page ≤ 80;
//      orientation landscape | portrait | square; size large (4K) | medium (Full HD) | small (HD))
//     → { page, per_page, total_results, videos: [{ id, width, height, url, image, duration,
//         user: { id, name, url }, video_files: [{ id, quality, file_type, width, height, fps, link }] }] }
//   Default limit: 200 requests per hour, 20,000 per month (set STUDIO_PROVIDER_RATE_PEXELS_VIDEO).
// Licence https://www.pexels.com/license/ (read 2026-09-28): free to use and modify,
// "Attribution is not required"; not allowed: selling unaltered copies, implying endorsement,
// showing identifiable people in a bad light. The creator is still recorded with the asset.
// The API is free, so a clip costs 0p.
//
// Synchronous: submit() searches and picks the file, and poll() returns its link. The link is
// copied into Studio's bucket by generate-asset (pipeline/persist.ts).

export const PROVIDER_ID = 'pexels-video';
const SEARCH_URL = 'https://api.pexels.com/v1/videos/search';
const PER_PAGE = 15;
const REQUEST_TIMEOUT_MS = 20_000;
/** Layer 6 renders at 1080p: prefer files whose short side is closest to it, never above 4K. */
const TARGET_SHORT_SIDE = 1080;
const MAX_LONG_SIDE = 3840;
export const PEXELS_LICENCE_URL = 'https://www.pexels.com/license/';

export interface PexelsVideoOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface PexelsVideoFile {
  id?: number;
  quality?: string | null;
  file_type?: string;
  width?: number | null;
  height?: number | null;
  link?: string;
}

interface PexelsVideo {
  id?: number;
  url?: string;
  duration?: number;
  width?: number;
  height?: number;
  user?: { name?: string; url?: string };
  video_files?: PexelsVideoFile[];
}

const PEXELS_ORIENTATION = {
  vertical: 'portrait',
  horizontal: 'landscape',
} as const;

/** The MP4 file closest to 1080p on its short side (ties: the smaller file), at most 4K. */
export function pickPexelsFile(files: PexelsVideoFile[] | undefined): PexelsVideoFile | undefined {
  const usable = (files ?? []).filter(
    (f) =>
      f.file_type === 'video/mp4' &&
      typeof f.link === 'string' &&
      f.link.startsWith('https://') &&
      typeof f.width === 'number' &&
      typeof f.height === 'number' &&
      Math.max(f.width, f.height) <= MAX_LONG_SIDE,
  );
  const score = (f: PexelsVideoFile) =>
    Math.abs(Math.min(f.width ?? 0, f.height ?? 0) - TARGET_SHORT_SIDE);
  return usable.sort((a, b) => score(a) - score(b) || (a.width ?? 0) - (b.width ?? 0))[0];
}

export class PexelsVideoAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['stock_footage'];
  readonly typicalLatencySec = 3;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: PexelsVideoOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** The Pexels API is free. */
  estimateCostPence(_request: ProviderRequest): number {
    return 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'stock_footage') {
      throw this.invalid(`Pexels video adapter does not support ${request.capability}`);
    }
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
      await this.search(new URLSearchParams({ query: 'city', per_page: '1' }));
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err as Error).message };
    }
  }

  private async find(request: StockFootageRequest): Promise<ProviderPollResult> {
    const keywords = footageKeywords(request.query);
    if (keywords.length === 0) throw this.invalid('Scene description has no searchable words');
    const params = new URLSearchParams({
      query: keywords.join(' '),
      per_page: String(PER_PAGE),
      size: 'medium',
    });
    const orientation = footageOrientation(request.aspectRatio);
    if (orientation !== 'any') params.set('orientation', PEXELS_ORIENTATION[orientation]);
    const body = (await this.search(params)) as { videos?: PexelsVideo[] };
    for (const video of body.videos ?? []) {
      if (video.id === undefined || (video.duration ?? 0) < request.durationSec) continue;
      const file = pickPexelsFile(video.video_files);
      if (!file?.link) continue;
      const licence: StockLicence = {
        licence: 'pexels',
        licenceUrl: PEXELS_LICENCE_URL,
        attributionRequired: false,
        creator: video.user?.name?.slice(0, 200) ?? null,
        creatorUrl: video.user?.url ?? null,
        sourcePageUrl: video.url ?? null,
      };
      return {
        state: 'succeeded',
        output: {
          url: file.link,
          metadata: {
            stockItemId: String(video.id),
            fileId: file.id ?? null,
            width: file.width ?? null,
            height: file.height ?? null,
            durationSec: video.duration ?? null,
            keywords,
            licence,
            costPence: 0,
          },
        },
      };
    }
    return {
      state: 'failed',
      error: {
        class: 'invalid_request',
        message: `No Pexels clip of ${request.durationSec}s+ matched "${keywords.join(' ')}"`,
        retryable: false,
      },
    };
  }

  private async search(params: URLSearchParams): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${SEARCH_URL}?${params}`, {
        headers: { Authorization: this.options.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const classification: ErrorClassification = classifyHttpStatus(res.status);
      throw providerError(PROVIDER_ID, classification, `Pexels returned HTTP ${res.status}`);
    }
    return res.json() as Promise<unknown>;
  }

  private invalid(message: string) {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
