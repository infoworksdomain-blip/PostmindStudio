import { ProviderError } from '../../errors';
import { httpJson } from './http';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import { usdToPence } from './pricing';
import { providerError } from './provider-errors';
import { findLanguage } from '../languages';

// AssemblyAI async transcription (BACKLOG 9.1 step 3; spec 6.5 captions). Contract from
// assemblyai.com/docs (read 2026-09-27):
//   base https://api.assemblyai.com (EU: https://api.eu.assemblyai.com), header authorization: <key>
//   POST /v2/transcript { audio_url } → { id, status }   (audio_url may be a presigned MP4 URL)
//   GET  /v2/transcript/{id} → status queued|processing|completed|error, text,
//        words[{text,start,end,confidence}] (ms), audio_duration (s), language_code, error
//   DELETE /v2/transcript/{id} removes the transcript
// speech_models is omitted so AssemblyAI's documented default routing applies.
// 15.C5 language: `language_code` per
// https://www.assemblyai.com/docs/pre-recorded-audio/supported-languages (read 2026-09-28).
// Universal-3.5 Pro supports en, en_uk, en_us, es, fr, de, it, pt, ar, hi, zh (among others),
// i.e. every Studio language, and the default speech_models ["universal-3-5-pro", "universal-2"]
// (https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model) covers them, so no
// specific model is needed. Portuguese has one code (`pt`, both dialects recognised); Chinese is
// `zh` (Mandarin). Without a code the request keeps its previous (pre-15.C5) behaviour. The docs state no per-language limit on word-level
// timestamps; for Mandarin a "word" is whatever token AssemblyAI returns (no spaces in the text).
// Pricing: Universal-3.5 Pro $0.21/hour (pricing page, pay-as-you-go).

export const PROVIDER_ID = 'assemblyai';
export const US_BASE_URL = 'https://api.assemblyai.com';
export const EU_BASE_URL = 'https://api.eu.assemblyai.com';
const USD_PER_HOUR = 0.21;
const TIMEOUT_MS = 30_000;

interface AssemblyTranscript {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  error?: string | null;
  text?: string | null;
  words?: Array<{ text: string; start: number; end: number; confidence: number }> | null;
  audio_duration?: number | null;
  language_code?: string | null;
}

export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface AssemblyAiOptions {
  apiKey: string;
  usdToGbpRate: number;
  region?: 'us' | 'eu';
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body)
    return String((body as { error: unknown }).error);
  return typeof body === 'string' ? body : undefined;
}

/** AssemblyAI language_code for each Studio language (BCP 47 → documented code). */
export const ASSEMBLYAI_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  'en-GB': 'en_uk',
  'en-US': 'en_us',
  fr: 'fr',
  es: 'es',
  ar: 'ar',
  de: 'de',
  it: 'it',
  'pt-BR': 'pt',
  'pt-PT': 'pt',
  hi: 'hi',
  'zh-Hans': 'zh',
};

/** The documented AssemblyAI code for a Studio language tag; undefined = let AssemblyAI decide. */
export function assemblyAiLanguageCode(tag: string | null | undefined): string | undefined {
  const language = findLanguage(tag);
  return language ? ASSEMBLYAI_LANGUAGE_CODES[language.code] : undefined;
}

export class AssemblyAiAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['transcription'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly options: AssemblyAiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = options.region === 'eu' ? EU_BASE_URL : US_BASE_URL;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<T>(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: { authorization: this.options.apiKey, 'content-type': 'application/json' },
      },
      { providerId: PROVIDER_ID, fetchImpl: this.fetchImpl, timeoutMs: TIMEOUT_MS, errorMessage },
    );
  }

  private pence(durationSec: number): number {
    return usdToPence((durationSec / 3600) * USD_PER_HOUR, this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    return request.capability === 'transcription' ? this.pence(request.durationSec) : 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'transcription') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `AssemblyAI adapter does not support ${request.capability}`,
      );
    }
    const { body } = await this.request<AssemblyTranscript>('/v2/transcript', {
      method: 'POST',
      body: JSON.stringify({
        audio_url: request.mediaUrl,
        ...(assemblyAiLanguageCode(request.languageCode) && {
          language_code: assemblyAiLanguageCode(request.languageCode),
        }),
      }),
    });
    return {
      providerJobId: body.id,
      estimatedCostPence: this.pence(request.durationSec),
      // Typically a fraction of real time; poll from shortly after submission.
      estimatedReadyAt: new Date(this.now() + Math.max(15, request.durationSec / 4) * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    let t: AssemblyTranscript;
    try {
      ({ body: t } = await this.request<AssemblyTranscript>(
        `/v2/transcript/${encodeURIComponent(providerJobId)}`,
        { method: 'GET' },
      ));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) {
        return {
          state: 'failed',
          error: { class: 'result_expired', message: 'Transcript not found', retryable: true },
        };
      }
      throw err;
    }
    if (t.status === 'queued' || t.status === 'processing') return { state: 'running' };
    if (t.status === 'error') {
      const message = t.error ?? 'AssemblyAI transcription failed';
      // Download/transcoding failures are about the input; retrying the same URL won't help.
      const input = /download|transcod|unsupported|no spoken audio/i.test(message);
      return {
        state: 'failed',
        error: {
          class: input ? 'invalid_request' : 'provider_unavailable',
          message,
          retryable: !input,
        },
      };
    }
    const words: TranscriptWord[] = (t.words ?? []).map((w) => ({
      text: w.text,
      startSec: w.start / 1000,
      endSec: w.end / 1000,
    }));
    return {
      state: 'succeeded',
      output: {
        metadata: {
          transcriptId: t.id,
          text: t.text ?? '',
          words,
          languageCode: t.language_code ?? null,
          audioDurationSec: t.audio_duration ?? null,
          ...(typeof t.audio_duration === 'number' && { costPence: this.pence(t.audio_duration) }),
        },
      },
    };
  }

  async cancel(providerJobId: string): Promise<void> {
    try {
      await this.request<unknown>(`/v2/transcript/${encodeURIComponent(providerJobId)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) return;
      throw err;
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    // No documented health endpoint; a 404 for an unknown transcript proves auth + reachability.
    try {
      await this.request<unknown>('/v2/transcript/healthcheck-probe', { method: 'GET' });
      return { healthy: true };
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) return { healthy: true };
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }
}
