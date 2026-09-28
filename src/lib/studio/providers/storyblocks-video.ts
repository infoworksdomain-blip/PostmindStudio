import { storyblocksAuth } from '../images/stock';
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

// Phase 15 (register 13.38 correction) — Layer 3 STOCK_FOOTAGE from the Storyblocks video
// catalogue (spec 6.4 STOCK_FOOTAGE: "storyblocks, pexels"). Contract from the Storyblocks API
// reference https://documentation.storyblocks.com/ (read 2026-09-28):
//   GET https://api.storyblocks.com/api/v2/videos/search?APIKEY&EXPIRES&HMAC&user_id&project_id
//       &keywords&content_type=footage&quality=HD&min_duration&orientation&results_per_page
//       &safe_search&sort_by=most_relevant
//     → { total_results, results: [{ id, title, type, thumbnail_url, preview_urls, duration,
//         durationMs, orientation }] }   (orientation: horizontal | vertical | all)
//   GET https://api.storyblocks.com/api/v2/videos/stock-item/download/:stock_item_id
//       ?APIKEY&EXPIRES&HMAC&user_id&project_id → { "MP4": { "_1080p": url, "_720p": url }, "MOV": … }
//   Auth: HMAC-SHA256 over the resource path, key = privateKey + EXPIRES (images/stock.ts).
//   user_id / project_id are opaque ids (the docs ask for no names or emails).
// Licence: royalty-free under the Storyblocks API licence (https://www.storyblocks.com/business-solution/api);
// the API plan is a flat subscription, so a clip costs 0p in Studio's ledger (the subscription
// is a fixed platform cost, runbooks/cost-runaway.md), as for the audio catalogue (13.27).
//
// Synchronous: submit() searches and asks for the download link, and poll() returns it. The
// download link is copied into Studio's bucket by generate-asset (pipeline/persist.ts), like
// any provider-hosted output.

export const PROVIDER_ID = 'storyblocks-video';
const BASE_URL = 'https://api.storyblocks.com';
const SEARCH_PATH = '/api/v2/videos/search';
const RESULTS_PER_PAGE = 10;
const REQUEST_TIMEOUT_MS = 20_000;
/** Resolutions tried in order (Layer 6 renders at 1080p). */
const RESOLUTION_ORDER = ['_1080p', '_720p', '_4k', '_2160p'];
export const STORYBLOCKS_LICENCE_URL = 'https://www.storyblocks.com/business-solution/api';

export interface StoryblocksVideoOptions {
  publicKey: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface VideoSearchResult {
  id?: number | string;
  title?: string;
  type?: string;
  duration?: number;
  durationMs?: number;
  thumbnail_url?: string;
}

function durationOf(hit: VideoSearchResult): number | null {
  if (typeof hit.durationMs === 'number') return hit.durationMs / 1000;
  return typeof hit.duration === 'number' ? hit.duration : null;
}

/** The MP4 link to use: 1080p first, then 720p, then any https MP4 link offered. */
export function pickStoryblocksMp4(links: unknown): string | undefined {
  if (!links || typeof links !== 'object') return undefined;
  const mp4 = (links as { MP4?: unknown }).MP4;
  if (!mp4 || typeof mp4 !== 'object') return undefined;
  const byResolution = mp4 as Record<string, unknown>;
  const ordered = [...RESOLUTION_ORDER.map((k) => byResolution[k]), ...Object.values(byResolution)];
  return ordered.find((u): u is string => typeof u === 'string' && u.startsWith('https://'));
}

export class StoryblocksVideoAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['stock_footage'];
  readonly typicalLatencySec = 5;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: StoryblocksVideoOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** Subscription licence: no per-download charge. */
  estimateCostPence(_request: ProviderRequest): number {
    return 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'stock_footage') {
      throw this.invalid(`Storyblocks video adapter does not support ${request.capability}`);
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

  /** A one-result search exercises the key and the HMAC and downloads nothing. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.getJson(SEARCH_PATH, {
        keywords: 'city',
        content_type: 'footage',
        results_per_page: '1',
        user_id: 'healthcheck',
        project_id: 'healthcheck',
      });
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err as Error).message };
    }
  }

  private async find(request: StockFootageRequest): Promise<ProviderPollResult> {
    const keywords = footageKeywords(request.query);
    if (keywords.length === 0) throw this.invalid('Scene description has no searchable words');
    const ids = { user_id: request.organisationId, project_id: request.projectId ?? 'no-project' };
    const orientation = footageOrientation(request.aspectRatio);
    const search = (await this.getJson(SEARCH_PATH, {
      keywords: keywords.join(','),
      content_type: 'footage',
      quality: 'HD',
      min_duration: String(Math.max(1, Math.ceil(request.durationSec))),
      ...(orientation !== 'any' && { orientation }),
      results_per_page: String(RESULTS_PER_PAGE),
      safe_search: 'true',
      sort_by: 'most_relevant',
      ...ids,
    })) as { results?: VideoSearchResult[] };
    const hit = (search.results ?? []).find(
      (r) => r.id !== undefined && (durationOf(r) ?? 0) >= request.durationSec,
    );
    if (!hit || hit.id === undefined) {
      return {
        state: 'failed',
        error: {
          class: 'invalid_request',
          message: `No Storyblocks clip of ${request.durationSec}s+ matched "${keywords.join(' ')}"`,
          retryable: false,
        },
      };
    }
    const itemId = String(hit.id);
    const links = await this.getJson(
      `/api/v2/videos/stock-item/download/${encodeURIComponent(itemId)}`,
      ids,
    );
    const url = pickStoryblocksMp4(links);
    if (!url) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: false },
        'Storyblocks returned no MP4 download link',
      );
    }
    const licence: StockLicence = {
      licence: 'storyblocks-api',
      licenceUrl: STORYBLOCKS_LICENCE_URL,
      attributionRequired: false,
      creator: null,
      creatorUrl: null,
      sourcePageUrl: null,
    };
    return {
      state: 'succeeded',
      output: {
        url,
        metadata: {
          stockItemId: itemId,
          title: hit.title?.slice(0, 200) ?? null,
          durationSec: durationOf(hit),
          keywords,
          licence,
          costPence: 0,
        },
      },
    };
  }

  private async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const query = storyblocksAuth(
      { publicKey: this.options.publicKey, privateKey: this.options.privateKey },
      path,
      this.now(),
    );
    for (const [k, v] of Object.entries(params)) query.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}${path}?${query}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const classification: ErrorClassification = classifyHttpStatus(res.status);
      throw providerError(PROVIDER_ID, classification, `Storyblocks returned HTTP ${res.status}`);
    }
    return res.json() as Promise<unknown>;
  }

  private invalid(message: string) {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
