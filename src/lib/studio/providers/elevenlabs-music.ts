import { ConfigurationError } from '../../errors';
import { providerOutputKey, type AssetStorage } from '../storage';
import type {
  MusicRequest,
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import { usdToPence } from './pricing';
import {
  classifyHttpStatus,
  classifyNetworkError,
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { SyncJobStore } from './sync-jobs';

// Layer 5 music (spec 5.6). SPEC DRIFT: the spec names Suno v4, which has no public API
// (operator decision 2026-09-27); ElevenLabs Music replaces it.
//
// Contract from https://elevenlabs.io/docs/api-reference/music/compose (read 2026-09-27):
//   POST https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128
//   header xi-api-key; JSON body { prompt, music_length_ms (3000–600000), model_id
//   (music_v1 | music_v2 | music_v2_5; default music_v1), force_instrumental }.
//   `prompt` and `composition_plan` are mutually exclusive; we only send `prompt`.
//   200 = raw audio bytes in the requested format; response header `song-id`.
//   422 = { detail: [{ loc, msg, type }] } validation error.
// https://elevenlabs.io/docs/cookbooks/music/quickstart: a prompt naming a band/musician or
// quoting copyrighted lyrics fails with detail.status "bad_prompt" (+ data.prompt_suggestion).
// https://elevenlabs.io/docs/overview/capabilities/music: "minimum duration of 3 seconds and a
// maximum duration of 5 minutes"; "available for paid subscribers"; "cleared for nearly all
// commercial uses … social media videos". We honour the stricter 5-minute product limit (the
// API reference allows 600000 ms); longer videos loop the track in the composition (edl.ts).
// https://elevenlabs.io/pricing/api: Music "$0.15 Price per minute", "Commercial use licensing
// on Starter+ plans" — the account must be on a paid plan (Starter or above).
// https://elevenlabs.io/music-terms: input must not contain "any artist's … real name or stage
// name" — the prompt builder only emits controlled-vocabulary descriptors.
//
// Synchronous: submit() stores the audio in S3 and parks the result for poll() (sync-jobs.ts).

export const PROVIDER_ID = 'elevenlabs-music';
const BASE_URL = 'https://api.elevenlabs.io';
export const DEFAULT_MUSIC_MODEL = 'music_v2_5';
const MODELS: ReadonlySet<string> = new Set(['music_v1', 'music_v2', 'music_v2_5']);
const OUTPUT_FORMAT = 'mp3_44100_128';
export const MIN_MUSIC_SEC = 3;
export const MAX_MUSIC_SEC = 300;
/** USD per minute of generated audio, same on every paid plan (elevenlabs.io/pricing/api). */
export const USD_PER_MINUTE = 0.15;
const MAX_PROMPT_CHARS = 2_000;
// Generation time is not documented; a 5-minute track can take minutes. Kept below the
// pipeline's per-provider timeout (15 min).
const REQUEST_TIMEOUT_MS = 6 * 60_000;

export interface ElevenLabsMusicAdapterOptions {
  apiKey: string;
  storage: AssetStorage;
  bucket: string;
  usdToGbpRate: number;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface MusicErrorBody {
  detail?:
    | {
        status?: string;
        code?: string;
        message?: string;
        data?: { prompt_suggestion?: string };
      }
    | Array<{ loc?: unknown[]; msg?: string; type?: string }>
    | string;
}

export async function classifyMusicError(
  res: Response,
): Promise<{ classification: ErrorClassification; message: string }> {
  const body = (await res.json().catch(() => ({}))) as MusicErrorBody;
  const { detail } = body;
  if (Array.isArray(detail)) {
    const msg = detail.map((d) => `${(d.loc ?? []).join('.')}: ${d.msg ?? d.type ?? ''}`);
    return {
      classification: classifyHttpStatus(res.status),
      message: `validation: ${msg.join('; ')}`,
    };
  }
  const obj = typeof detail === 'object' ? detail : undefined;
  const code = obj?.status ?? obj?.code;
  const message = obj?.message ?? (typeof detail === 'string' ? detail : res.statusText);
  if (code === 'bad_prompt' || code === 'bad_composition_plan') {
    // Documented refusal for copyrighted material (artist names, lyrics). Not retryable with
    // the same prompt; the provider's suggestion is not auto-applied (it is unreviewed text).
    return {
      classification: { errorClass: 'content_policy', retryable: false },
      message: `${code}: ${message}`,
    };
  }
  if (code === 'insufficient_credits' || code === 'quota_exceeded') {
    return { classification: { errorClass: 'insufficient_credits', retryable: false }, message };
  }
  return {
    classification: classifyHttpStatus(res.status),
    message: `${code ?? res.status}: ${message}`,
  };
}

/** Clamp a requested length to the documented 3 s – 5 min range, in whole milliseconds. */
export function musicLengthMs(durationSec: number): number {
  const sec = Math.min(MAX_MUSIC_SEC, Math.max(MIN_MUSIC_SEC, durationSec));
  return Math.round(sec * 1000);
}

export class ElevenLabsMusicAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['music'];
  readonly typicalLatencySec = 60;

  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: ElevenLabsMusicAdapterOptions) {
    this.model = options.model ?? DEFAULT_MUSIC_MODEL;
    if (!MODELS.has(this.model)) {
      throw new ConfigurationError(`Unsupported ElevenLabs music model ${this.model}`);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  costPenceForMs(lengthMs: number): number {
    return usdToPence((USD_PER_MINUTE * lengthMs) / 60_000, this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    return request.capability === 'music'
      ? this.costPenceForMs(musicLengthMs(request.durationSec))
      : 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'music') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `ElevenLabs Music adapter does not support ${request.capability}`,
      );
    }
    const result = await this.compose(request);
    const costPence =
      (result.output?.metadata as { costPence?: number } | undefined)?.costPence ?? 0;
    return {
      providerJobId: this.results.put(result),
      estimatedCostPence: costPence,
      estimatedReadyAt: new Date(this.now()),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    return this.results.get(providerJobId);
  }

  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  /** Same documented endpoint as the TTS adapter's check: key valid and account reachable. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const res = await this.fetchImpl(`${BASE_URL}/v1/user/subscription`, {
        headers: { 'xi-api-key': this.options.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true };
      const { classification, message } = await classifyMusicError(res);
      return { healthy: false, reason: `${classification.errorClass}: ${message}` };
    } catch (err) {
      return {
        healthy: false,
        reason: `${classifyNetworkError(err).errorClass}: ${(err as Error).message}`,
      };
    }
  }

  private async compose(request: MusicRequest): Promise<ProviderPollResult> {
    const prompt = request.prompt.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Music prompt must be 1–${MAX_PROMPT_CHARS} characters`,
      );
    }
    if (!Number.isFinite(request.durationSec) || request.durationSec <= 0) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        'Music duration must be a positive number of seconds',
      );
    }
    const lengthMs = musicLengthMs(request.durationSec);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}/v1/music?output_format=${OUTPUT_FORMAT}`, {
        method: 'POST',
        headers: {
          'xi-api-key': this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          prompt,
          music_length_ms: lengthMs,
          model_id: this.model,
          force_instrumental: true, // background bed: never lyrics (spec 5.6 sits under VO)
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    if (!res.ok) {
      const { classification, message } = await classifyMusicError(res);
      throw providerError(PROVIDER_ID, classification, message, { status: res.status });
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength === 0) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Empty audio response',
      );
    }
    const costPence = this.costPenceForMs(lengthMs);
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
    return {
      state: 'succeeded',
      output: {
        url: stored.url,
        metadata: {
          model: this.model,
          outputFormat: OUTPUT_FORMAT,
          lengthMs,
          durationSec: lengthMs / 1000,
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          bytes: audio.byteLength,
          songId: res.headers.get('song-id'),
          costPence,
        },
      },
    };
  }
}
