import { ConfigurationError, ProviderError } from '../../errors';
import { providerOutputKey, type AssetStorage } from '../storage';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
  TtsRequest,
} from './interface';
import { usdToPence } from './pricing';
import {
  classifyHttpStatus,
  classifyNetworkError,
  providerError,
  type ErrorClassification,
} from './provider-errors';
import { SyncJobStore } from './sync-jobs';
import { elevenLabsLanguageCode } from '../pipeline/voice-language';
import { alignmentToWords, parseCharacterAlignment } from '../pipeline/tts-alignment';
import type { SpokenWord } from '../overlays/word-timing';

// BACKLOG 2.7 — ElevenLabs TTS (Layer 4, spec 5.5). Contract from
// elevenlabs.io/docs/api-reference/text-to-speech/convert (read 2026-09-27):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
//   header xi-api-key; body { text, model_id, language_code? }; response = raw audio bytes;
//   response header `character-cost` = characters billed.
// Synchronous: submit() stores the audio in S3 and parks the result for poll().
//
// 23.2: by default the narration is made with "Create speech with timing"
// (https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps, read 2026-10-06):
//   POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=… with the same body; the
//   200 response is JSON { audio_base64, alignment?, normalized_alignment? } where alignment is
//   { characters[], character_start_times_seconds[], character_end_times_seconds[] } for the
//   original text. The audio is stored as before, and the alignment becomes the narration's word
//   timings (metadata.alignedWords, pipeline/tts-alignment.ts), so the narration no longer has to
//   be transcribed for captions. ELEVENLABS_WORD_TIMINGS=off goes back to the plain endpoint.

export const PROVIDER_ID = 'elevenlabs';
export const BASE_URL = 'https://api.elevenlabs.io';
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const REQUEST_TIMEOUT_MS = 120_000;
export const MIN_SPEED = 0.7;
export const MAX_SPEED = 1.2;

/** Max characters per request (elevenlabs.io/docs/models). */
const MAX_CHARS: Readonly<Record<string, number>> = {
  eleven_v3: 5_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
};

// USD per 1,000 characters (elevenlabs.io/pricing/api). Flash $0.05 and v3 $0.10 are listed
// explicitly. eleven_multilingual_v2 is priced at the "Multilingual" $0.10 rate: CONFIRM at
// GATE 2 against the account's actual plan.
const USD_PER_1K_CHARS: Readonly<Record<string, number>> = {
  eleven_v3: 0.1,
  eleven_multilingual_v2: 0.1,
  eleven_flash_v2_5: 0.05,
  eleven_flash_v2: 0.05,
};

export interface ElevenLabsAdapterOptions {
  apiKey: string;
  storage: AssetStorage;
  bucket: string;
  usdToGbpRate: number;
  model?: string;
  /** 23.2: use /with-timestamps and return the narration's word timings (default true). */
  wordTimings?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** ELEVENLABS_WORD_TIMINGS: on (default) | off. */
export function wordTimingsFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env.ELEVENLABS_WORD_TIMINGS?.trim().toLowerCase();
  if (!raw || raw === 'on' || raw === 'true') return true;
  if (raw === 'off' || raw === 'false') return false;
  throw new ConfigurationError('ELEVENLABS_WORD_TIMINGS must be on or off');
}

interface TimestampedSpeech {
  audio_base64?: unknown;
  alignment?: unknown;
}

interface ElevenLabsErrorBody {
  detail?: { code?: string; status?: string; message?: string } | string;
}

async function classifyResponse(
  res: Response,
): Promise<{ classification: ErrorClassification; message: string }> {
  const body = (await res.json().catch(() => ({}))) as ElevenLabsErrorBody;
  const detail = typeof body.detail === 'object' ? body.detail : undefined;
  const code = detail?.code ?? detail?.status;
  const message =
    detail?.message ?? (typeof body.detail === 'string' ? body.detail : res.statusText);
  // Docs disagree on quota errors (402 insufficient_credits vs older 401 quota_exceeded).
  if (code === 'insufficient_credits' || code === 'quota_exceeded') {
    return { classification: { errorClass: 'insufficient_credits', retryable: false }, message };
  }
  return {
    classification: classifyHttpStatus(res.status),
    message: `${code ?? res.status}: ${message}`,
  };
}

/**
 * 20.11: the health check reads /v1/user/subscription, which needs the key's `user_read`
 * permission. Keys restricted to the product areas Studio uses (text to speech, music) answer
 * 401/403 "missing the permission user_read" (elevenlabs.io/docs/eleven-api/resources/errors,
 * read 2026-09-30: 401 authentication_error / 403 authorization_error insufficient_permissions).
 * The key authenticated; only the subscription is unreadable, so the provider is healthy for TTS.
 */
export function missingUserReadOnly(errorClass: string, message: string): boolean {
  return errorClass === 'auth' && /\buser_read\b/.test(message);
}

export const USER_READ_NOTE =
  'key valid; it lacks the user_read permission, so the subscription check was skipped';

export class ElevenLabsAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['tts'];
  readonly typicalLatencySec = 20; // spec 5.1: 5–20s per shot

  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly results: SyncJobStore;

  constructor(private readonly options: ElevenLabsAdapterOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    if (!USD_PER_1K_CHARS[this.model] || !MAX_CHARS[this.model]) {
      throw new ConfigurationError(`Unsupported ElevenLabs model ${this.model}`);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.results = new SyncJobStore(PROVIDER_ID, this.now);
  }

  costPenceForChars(chars: number): number {
    return usdToPence(
      ((USD_PER_1K_CHARS[this.model] ?? 0) * chars) / 1000,
      this.options.usdToGbpRate,
    );
  }

  estimateCostPence(request: ProviderRequest): number {
    return request.capability === 'tts' ? this.costPenceForChars(request.text.length) : 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'tts') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `ElevenLabs adapter does not support ${request.capability}`,
      );
    }
    const result = await this.synthesise(request);
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

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const res = await this.fetchImpl(`${BASE_URL}/v1/user/subscription`, {
        headers: { 'xi-api-key': this.options.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { healthy: true };
      const { classification, message } = await classifyResponse(res);
      if (missingUserReadOnly(classification.errorClass, message)) {
        return { healthy: true, reason: USER_READ_NOTE };
      }
      return { healthy: false, reason: `${classification.errorClass}: ${message}` };
    } catch (err) {
      return {
        healthy: false,
        reason: `${classifyNetworkError(err).errorClass}: ${(err as Error).message}`,
      };
    }
  }

  private async synthesise(request: TtsRequest): Promise<ProviderPollResult> {
    const maxChars = MAX_CHARS[this.model] ?? 0;
    if (request.text.length === 0 || request.text.length > maxChars) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Text must be 1–${maxChars} characters for ${this.model}`,
      );
    }
    const timed = this.options.wordTimings ?? true;
    const path = timed ? '/with-timestamps' : '';
    const url = `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}${path}?output_format=${OUTPUT_FORMAT}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: timed ? 'application/json' : 'audio/mpeg',
        },
        body: JSON.stringify({
          text: request.text,
          model_id: this.model,
          // 15.C5: language_code (ISO 639-1) only for models that accept it — the docs say it
          // "is not supported for multilingual_v2 models" (pipeline/voice-language.ts).
          ...(elevenLabsLanguageCode(this.model, request.languageCode) && {
            language_code: elevenLabsLanguageCode(this.model, request.languageCode),
          }),
          // 15.B3: voice_settings.speed ("values greater than 1.0 speed it up", default 1;
          // https://elevenlabs.io/docs/api-reference/text-to-speech/convert, read 2026-09-28).
          // ElevenLabs documents 0.7–1.2 as the supported range
          // (https://elevenlabs.io/docs/eleven-agents/customization/voice/speed-control).
          ...(request.speed !== undefined &&
            request.speed !== 1 && {
              voice_settings: { speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, request.speed)) },
            }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
    }
    if (!res.ok) {
      const { classification, message } = await classifyResponse(res);
      throw providerError(PROVIDER_ID, classification, message, { status: res.status });
    }

    const { audio, alignedWords } = timed
      ? await this.readTimestamped(res, request.text)
      : { audio: new Uint8Array(await res.arrayBuffer()), alignedWords: null };
    if (audio.byteLength === 0) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Empty audio response',
      );
    }
    const billedChars = Number(res.headers.get('character-cost'));
    const chars =
      Number.isFinite(billedChars) && billedChars > 0 ? billedChars : request.text.length;
    const costPence = this.costPenceForChars(chars);
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
          voiceId: request.voiceId,
          outputFormat: OUTPUT_FORMAT,
          s3Bucket: stored.bucket,
          s3Key: stored.key,
          bytes: audio.byteLength,
          characters: chars,
          requestId: res.headers.get('request-id'),
          costPence,
          // 23.2: word timings from the alignment (absent = transcribe as before).
          ...(alignedWords && { alignedWords }),
        },
      },
    };
  }

  /** The /with-timestamps JSON: decoded audio and the words of a usable alignment (else null). */
  private async readTimestamped(
    res: Response,
    text: string,
  ): Promise<{ audio: Uint8Array; alignedWords: SpokenWord[] | null }> {
    let body: TimestampedSpeech;
    try {
      body = (await res.json()) as TimestampedSpeech;
    } catch {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Speech-with-timing response was not JSON',
      );
    }
    const audio =
      typeof body.audio_base64 === 'string'
        ? new Uint8Array(Buffer.from(body.audio_base64, 'base64'))
        : new Uint8Array();
    const alignment = parseCharacterAlignment(body.alignment);
    return { audio, alignedWords: alignment ? alignmentToWords(alignment, text) : null };
  }
}

export { ProviderError };
