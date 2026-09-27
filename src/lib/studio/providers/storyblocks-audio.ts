import { storyblocksAuth } from '../images/stock';
import { providerOutputKey, type AssetStorage } from '../storage';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
  SfxRequest,
} from './interface';
import {
  classifyHttpStatus,
  classifyNetworkError,
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// BACKLOG 13.27 — Layer 5 sound effects (spec 5.6: "SFX (whooshes, hits, stingers) are selected
// from the Storyblocks catalog"). Contract from the Storyblocks API reference
// https://documentation.storyblocks.com/ (read 2026-09-27):
//   GET https://api.storyblocks.com/api/v2/audio/search?APIKEY&EXPIRES&HMAC&project_id&user_id
//       &keywords&content_type=sfx&max_duration&results_per_page&safe_search&sort_by
//     → { total_results, results: [{ id, title, type, preview_url, duration, durationMs, … }] }
//     ("content_type … Possible values include music, sfx, and all"; results_per_page ≤ 250)
//   GET https://api.storyblocks.com/api/v2/audio/stock-item/download/:stock_item_id
//       ?APIKEY&EXPIRES&HMAC&project_id&user_id → { "MP3": "<url>", "WAV": "<url>" }
//   Auth: HMAC-SHA256 over the resource path with key = privateKey + EXPIRES (same scheme as the
//   image search in images/stock.ts). user_id / project_id are opaque ids (never names/emails).
// Storyblocks is a flat subscription (unlimited downloads on the API plan), so a clip costs 0p
// in Studio's ledger; the subscription is a fixed platform cost (runbooks/cost-runaway.md).
//
// Synchronous: submit() searches, downloads the MP3 and stores it in S3, then parks the result
// for poll() (sync-jobs.ts), like the other byte-returning adapters.

export const PROVIDER_ID = 'storyblocks-audio';
const BASE_URL = 'https://api.storyblocks.com';
const SEARCH_PATH = '/api/v2/audio/search';
const RESULTS_PER_PAGE = 5;
const REQUEST_TIMEOUT_MS = 20_000;
/** SFX files are short; anything bigger is not what we asked for. */
export const MAX_SFX_BYTES = 10 * 1024 * 1024;
const MAX_QUERY_CHARS = 80;

export interface StoryblocksAudioOptions {
  publicKey: string;
  privateKey: string;
  storage: AssetStorage;
  bucket: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface AudioSearchResult {
  id?: number | string;
  title?: string;
  type?: string;
  duration?: number;
  durationMs?: number;
}

/** Reduce a cue to search keywords: letters, digits, spaces and hyphens only. */
export function sfxKeywords(cue: string): string {
  return cue
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS)
    .trim();
}

export class StoryblocksAudioAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['sfx'];
  readonly typicalLatencySec = 5;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: StoryblocksAudioOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  /** Subscription licence: no per-download charge. */
  estimateCostPence(_request: ProviderRequest): number {
    return 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'sfx') {
      throw this.invalid(`Storyblocks audio adapter does not support ${request.capability}`);
    }
    const result = await this.fetchSfx(request);
    return {
      providerJobId: this.results.put(result),
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

  /** A one-result search is free and exercises the key and HMAC. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.getJson(SEARCH_PATH, {
        keywords: 'whoosh',
        content_type: 'sfx',
        results_per_page: '1',
        user_id: 'healthcheck',
        project_id: 'healthcheck',
      });
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: (err as Error).message };
    }
  }

  private async fetchSfx(request: SfxRequest): Promise<ProviderPollResult> {
    const keywords = sfxKeywords(request.query);
    if (!keywords) throw this.invalid('SFX cue has no searchable words');
    const ids = { user_id: request.organisationId, project_id: request.projectId ?? 'no-project' };
    const search = (await this.getJson(SEARCH_PATH, {
      keywords,
      content_type: 'sfx',
      max_duration: String(Math.max(1, Math.ceil(request.maxDurationSec))),
      results_per_page: String(RESULTS_PER_PAGE),
      safe_search: 'true',
      sort_by: 'most_relevant',
      ...ids,
    })) as { results?: AudioSearchResult[] };
    const hit = (search.results ?? []).find((r) => r.id !== undefined && r.type !== 'music');
    if (!hit || hit.id === undefined) {
      return {
        state: 'failed',
        error: {
          class: 'invalid_request',
          message: `No Storyblocks SFX matched "${keywords}"`,
          retryable: false,
        },
      };
    }
    const itemId = String(hit.id);
    const links = (await this.getJson(
      `/api/v2/audio/stock-item/download/${encodeURIComponent(itemId)}`,
      ids,
    )) as { MP3?: string; WAV?: string };
    const mp3 = links.MP3;
    if (!mp3 || !mp3.startsWith('https://')) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: false },
        'Storyblocks returned no MP3 download link',
      );
    }
    const audio = await this.download(mp3);
    const stored = await this.options.storage.put({
      bucket: this.options.bucket,
      key: providerOutputKey({
        organisationId: request.organisationId,
        projectId: request.projectId,
        providerId: PROVIDER_ID,
        extension: 'mp3',
      }),
      body: audio,
      contentType: 'audio/mpeg',
    });
    const durationSec =
      typeof hit.durationMs === 'number'
        ? hit.durationMs / 1000
        : typeof hit.duration === 'number'
          ? hit.duration
          : null;
    return {
      state: 'succeeded',
      output: {
        url: stored.url,
        metadata: {
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          bytes: audio.byteLength,
          durationSec,
          stockItemId: itemId,
          title: hit.title?.slice(0, 200) ?? null,
          keywords,
          costPence: 0,
        },
      },
    };
  }

  private async download(url: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw providerError(
        PROVIDER_ID,
        classifyHttpStatus(res.status),
        `SFX download HTTP ${res.status}`,
      );
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_SFX_BYTES) {
      await res.body?.cancel();
      throw this.invalid(`SFX file is ${declared} bytes (max ${MAX_SFX_BYTES})`);
    }
    // Enforce the cap while streaming, not only after the fact: a response with no (or a lying)
    // content-length header must not be fully buffered before its size is checked.
    const bytes = await this.readCapped(res);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SFX_BYTES) {
      throw this.invalid(`SFX file size ${bytes.byteLength} bytes is out of range`);
    }
    return bytes;
  }

  private async readCapped(res: Response): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_SFX_BYTES) {
          await reader.cancel();
          throw this.invalid(`SFX file exceeded the ${MAX_SFX_BYTES} byte limit while downloading`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
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
