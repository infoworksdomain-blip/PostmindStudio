import { storyblocksAuth } from '../images/stock';
import { copyUrlToStorage } from '../pipeline/persist';
import { extractGenres, extractMoods } from '../pipeline/music-prompt';
import { providerOutputKey, type AssetStorage } from '../storage';
import type {
  MusicRequest,
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import {
  classifyHttpStatus,
  classifyNetworkError,
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// 15.C2 — Layer 5 music fallback (spec 5.6: "Music fallback: … or a Storyblocks library
// selection"). Contract from the Storyblocks API reference https://documentation.storyblocks.com/
// (read 2026-09-28), the same audio catalogue as the 13.27 SFX adapter:
//   GET https://api.storyblocks.com/api/v2/audio/search?APIKEY&EXPIRES&HMAC&user_id&project_id
//       &keywords&content_type=music&min_duration&has_vocals&results_per_page&safe_search&sort_by
//     → { total_results, results: [{ id, title, type: "music", duration, durationMs, bpm, … }] }
//   GET https://api.storyblocks.com/api/v2/audio/stock-item/download/:stock_item_id
//       ?APIKEY&EXPIRES&HMAC&user_id&project_id → { "MP3": "<url>", "WAV": "<url>" }
// Search keywords come only from the fenced mood/genre vocabulary of the music prompt
// (pipeline/music-prompt.ts), so no free text reaches the search. Subscription licence: 0p a
// track (the API plan is a fixed platform cost). The MP3 is copied into Studio's bucket here
// because Layer 5 (pipeline/music.ts) reads s3Bucket/s3Key from the result.

export const PROVIDER_ID = 'storyblocks-music';
const BASE_URL = 'https://api.storyblocks.com';
const SEARCH_PATH = '/api/v2/audio/search';
const RESULTS_PER_PAGE = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_KEYWORDS = 4;
const FALLBACK_KEYWORDS = ['upbeat', 'corporate'];

export interface StoryblocksMusicOptions {
  publicKey: string;
  privateKey: string;
  storage: AssetStorage;
  bucket: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface MusicSearchResult {
  id?: number | string;
  title?: string;
  type?: string;
  duration?: number;
  durationMs?: number;
  bpm?: number;
}

/** Search words: moods and genres from the (vocabulary-fenced) music prompt. */
export function musicKeywords(prompt: string): string[] {
  const words = [...extractMoods(prompt).slice(0, 3), ...extractGenres(prompt).slice(0, 1)];
  const unique = [...new Set(words)].slice(0, MAX_KEYWORDS);
  return unique.length > 0 ? unique : FALLBACK_KEYWORDS;
}

function durationOf(hit: MusicSearchResult): number | null {
  if (typeof hit.durationMs === 'number') return hit.durationMs / 1000;
  return typeof hit.duration === 'number' ? hit.duration : null;
}

export class StoryblocksMusicAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['music'];
  readonly typicalLatencySec = 10;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: StoryblocksMusicOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** Subscription licence: no per-download charge. */
  estimateCostPence(_request: ProviderRequest): number {
    return 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'music') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Storyblocks music adapter does not support ${request.capability}`,
      );
    }
    return {
      providerJobId: this.results.put(await this.pick(request)),
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
      await this.getJson(SEARCH_PATH, {
        keywords: 'upbeat',
        content_type: 'music',
        results_per_page: '1',
        user_id: 'healthcheck',
        project_id: 'healthcheck',
      });
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err as Error).message };
    }
  }

  private async pick(request: MusicRequest): Promise<ProviderPollResult> {
    const keywords = musicKeywords(request.prompt);
    const ids = { user_id: request.organisationId, project_id: request.projectId ?? 'no-project' };
    const minSec = Math.max(1, Math.ceil(request.durationSec));
    const search = (await this.getJson(SEARCH_PATH, {
      keywords: keywords.join(','),
      content_type: 'music',
      min_duration: String(minSec),
      has_vocals: 'false',
      results_per_page: String(RESULTS_PER_PAGE),
      safe_search: 'true',
      sort_by: 'most_relevant',
      ...ids,
    })) as { results?: MusicSearchResult[] };
    const hit = (search.results ?? []).find(
      (r) => r.id !== undefined && r.type !== 'sfx' && (durationOf(r) ?? 0) >= request.durationSec,
    );
    if (!hit || hit.id === undefined) {
      return {
        state: 'failed',
        error: {
          class: 'invalid_request',
          message: `No Storyblocks track of ${minSec}s+ matched "${keywords.join(' ')}"`,
          retryable: false,
        },
      };
    }
    const itemId = String(hit.id);
    const links = (await this.getJson(
      `/api/v2/audio/stock-item/download/${encodeURIComponent(itemId)}`,
      ids,
    )) as { MP3?: unknown };
    if (typeof links.MP3 !== 'string' || !links.MP3.startsWith('https://')) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: false },
        'Storyblocks returned no MP3 download link',
      );
    }
    const stored = await copyUrlToStorage(
      this.options.storage,
      {
        url: links.MP3,
        bucket: this.options.bucket,
        key: providerOutputKey({
          organisationId: request.organisationId,
          projectId: request.projectId,
          providerId: PROVIDER_ID,
          extension: 'mp3',
        }),
        fallbackContentType: 'audio/mpeg',
        providerId: PROVIDER_ID,
      },
      this.fetchImpl,
    );
    return {
      state: 'succeeded',
      output: {
        url: stored.url,
        metadata: {
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          bytes: stored.bytes,
          durationSec: durationOf(hit),
          stockItemId: itemId,
          title: hit.title?.slice(0, 200) ?? null,
          bpm: typeof hit.bpm === 'number' ? hit.bpm : null,
          keywords,
          licence: 'storyblocks-api',
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
}
