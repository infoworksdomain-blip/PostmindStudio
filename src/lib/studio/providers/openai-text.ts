import type OpenAI from 'openai';
import { toFile } from 'openai';
import type { ProviderPollResult, TextGenerationRequest, TranscriptionRequest } from './interface';
import { usdToPence } from './pricing';
import { classifyHttpStatus, classifyNetworkError, providerError } from './provider-errors';

// 15.C1 — OpenAI text generation (Layers 1–2 fallback; spec 5.2 "Claude Sonnet by default …;
// GPT-4o as fallback") and speech-to-text (Layer 8 captions fallback; spec 6.5 names Whisper).
// Contracts from the OpenAI docs (read 2026-09-28):
//   - Responses API https://developers.openai.com/api/docs/guides/structured-outputs :
//     POST /v1/responses { model, instructions, input, max_output_tokens,
//       text: { format: { type: 'json_schema', name, schema, strict } } }
//     → { status: completed | incomplete, incomplete_details: { reason: max_output_tokens |
//       content_filter }, output: [{ type: 'message', content: [{ type: 'output_text', text } |
//       { type: 'refusal', refusal }] }], usage: { input_tokens, input_tokens_details:
//       { cached_tokens }, output_tokens } }.
//     strict: true needs every property in `required` and additionalProperties: false on every
//     object; schemas with optional properties (e.g. the script's sfxCue) are sent with
//     strict: false and still validated by the caller's zod schema.
//   - SPEC DRIFT: GPT-4o is a legacy model. The default is gpt-6-sol, which the models page
//     (https://developers.openai.com/api/docs/models) lists as the balanced general model;
//     OPENAI_TEXT_MODEL overrides it (any model with a row in TEXT_PRICING).
//   - Speech to text https://developers.openai.com/api/docs/guides/speech-to-text :
//     POST /v1/audio/transcriptions (multipart file ≤ 25 MB; mp3, mp4, mpeg, mpga, m4a, wav,
//     webm) "Use whisper-1 when you need word or segment timestamps":
//     response_format verbose_json + timestamp_granularities ['word'] → { text, language,
//     duration, words: [{ word, start, end }] } (seconds). $0.006 a minute.
// Prices: https://developers.openai.com/api/docs/pricing (read 2026-09-28), USD per 1M tokens.

export const DEFAULT_TEXT_MODEL = 'gpt-6-sol';
export const TRANSCRIPTION_MODEL = 'whisper-1';
const TRANSCRIPTION_USD_PER_MINUTE = 0.006;
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Vision input upper bound per image, as for Claude (anthropic.ts). */
const IMAGE_TOKENS_UPPER_BOUND = 1_600;

export const TEXT_PRICING: Readonly<
  Record<string, { input: number; cachedInput: number; output: number }>
> = {
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
};

export interface OpenAITextClient {
  responses: {
    create(
      params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    ): Promise<OpenAI.Responses.Response>;
  };
  audio: {
    transcriptions: {
      create(
        params: OpenAI.Audio.TranscriptionCreateParamsNonStreaming<'verbose_json'>,
      ): Promise<OpenAI.Audio.TranscriptionVerbose>;
    };
  };
}

const PROVIDER_ID = 'openai';

/** strict json_schema is allowed only when every object lists all its properties as required. */
export function isStrictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  if (!schema || typeof schema !== 'object') return true;
  const node = schema as Record<string, unknown>;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    const keys = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false) return false;
    if (!keys.every((k) => required.includes(k))) return false;
  }
  return Object.values(node).every(isStrictCompatible);
}

export function textCostUsd(model: string, usage: OpenAI.Responses.ResponseUsage | undefined) {
  const price = TEXT_PRICING[model];
  if (!price || !usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const fresh = Math.max(0, usage.input_tokens - cached);
  return (
    (fresh * price.input + cached * price.cachedInput + usage.output_tokens * price.output) /
    1_000_000
  );
}

/** Upper bound for the router's budget check: prompt at ~4 chars/token plus full output. */
export function estimateTextPence(model: string, request: TextGenerationRequest, rate: number) {
  const price = TEXT_PRICING[model] ?? { input: 0, cachedInput: 0, output: 0 };
  const inputTokens =
    Math.ceil((request.system.length + request.prompt.length) / 4) +
    (request.images?.length ?? 0) * IMAGE_TOKENS_UPPER_BOUND;
  const outputTokens = request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return usdToPence((inputTokens * price.input + outputTokens * price.output) / 1_000_000, rate);
}

export function transcriptionPence(durationSec: number, rate: number): number {
  return usdToPence((durationSec / 60) * TRANSCRIPTION_USD_PER_MINUTE, rate);
}

function textParams(model: string, request: TextGenerationRequest) {
  const content: OpenAI.Responses.ResponseInputMessageContentList = [
    ...(request.images ?? []).map((image) => ({
      type: 'input_image' as const,
      detail: 'auto' as const,
      image_url: `data:${image.mediaType};base64,${image.data}`,
    })),
    { type: 'input_text' as const, text: request.prompt },
  ];
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model,
    instructions: request.system,
    input: [{ role: 'user', content }],
    max_output_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    store: false,
  };
  if (request.outputSchema) {
    params.text = {
      format: {
        type: 'json_schema',
        name: 'studio_output',
        schema: request.outputSchema,
        strict: isStrictCompatible(request.outputSchema),
      },
    };
  }
  return params;
}

function refusalOf(response: OpenAI.Responses.Response): string | undefined {
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content) if (part.type === 'refusal') return part.refusal;
  }
  return undefined;
}

/** Turn a Responses API result into the same poll result shape the Anthropic adapter returns. */
export function textResult(
  response: OpenAI.Responses.Response,
  request: TextGenerationRequest,
  costPence: number,
): ProviderPollResult {
  const refusal = refusalOf(response);
  if (refusal !== undefined || response.incomplete_details?.reason === 'content_filter') {
    return {
      state: 'failed',
      error: { class: 'content_policy', message: 'OpenAI declined the request', retryable: false },
    };
  }
  if (response.status === 'incomplete') {
    return {
      state: 'failed',
      error: {
        class: 'output_truncated',
        message: `Output incomplete (${response.incomplete_details?.reason ?? 'unknown'})`,
        retryable: false,
      },
    };
  }
  const text = response.output_text ?? '';
  const metadata: Record<string, unknown> = {
    model: response.model,
    responseId: response.id,
    text,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    costPence,
  };
  if (request.outputSchema) {
    try {
      metadata.json = JSON.parse(text) as unknown;
    } catch {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: 'Structured output was not valid JSON',
          retryable: true,
        },
      };
    }
  }
  return { state: 'succeeded', output: { metadata } };
}

export async function generateText(
  client: OpenAITextClient,
  model: string,
  request: TextGenerationRequest,
  rate: number,
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ result: ProviderPollResult; costPence: number }> {
  const response = await call(() => client.responses.create(textParams(model, request)));
  const usd = textCostUsd(model, response.usage);
  const costPence =
    usd === undefined ? estimateTextPence(model, request, rate) : usdToPence(usd, rate);
  return { result: textResult(response, request, costPence), costPence };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

/** File name for the upload: the extension tells OpenAI the container format. */
export function transcriptionFileName(contentType: string | null, url: string): string {
  const fromType = contentType ? EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] : undefined;
  if (fromType) return `media.${fromType}`;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const ext = /\.([a-z0-9]{2,4})$/i.exec(path)?.[1]?.toLowerCase();
  return `media.${ext && Object.values(EXTENSIONS).includes(ext) ? ext : 'mp3'}`;
}

async function download(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; name: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw providerError(PROVIDER_ID, classifyNetworkError(err), (err as Error).message);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw providerError(
      PROVIDER_ID,
      classifyHttpStatus(res.status),
      `Media download HTTP ${res.status}`,
    );
  }
  const tooLarge = () =>
    providerError(
      PROVIDER_ID,
      { errorClass: 'invalid_request', retryable: false },
      `Media is over the ${MAX_TRANSCRIPTION_BYTES / 1024 / 1024} MB transcription limit`,
    );
  if (Number(res.headers.get('content-length') ?? 0) > MAX_TRANSCRIPTION_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TRANSCRIPTION_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) {
    throw providerError(
      PROVIDER_ID,
      { errorClass: 'invalid_request', retryable: false },
      'Media is empty',
    );
  }
  return { bytes, name: transcriptionFileName(res.headers.get('content-type'), url) };
}

export async function transcribe(
  client: OpenAITextClient,
  request: TranscriptionRequest,
  deps: { rate: number; fetchImpl: typeof fetch },
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ result: ProviderPollResult; costPence: number }> {
  const media = await download(request.mediaUrl, deps.fetchImpl);
  const file = await toFile(media.bytes, media.name);
  const verbose = await call(() =>
    client.audio.transcriptions.create({
      file,
      model: TRANSCRIPTION_MODEL,
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      // 15.C5: `language` takes ISO-639-1 ("improves accuracy and latency", openai SDK
      // TranscriptionCreateParams); a BCP 47 tag's first two letters are that code.
      ...(request.languageCode && { language: request.languageCode.slice(0, 2).toLowerCase() }),
    }),
  );
  const durationSec = typeof verbose.duration === 'number' ? verbose.duration : request.durationSec;
  const costPence = transcriptionPence(durationSec, deps.rate);
  return {
    costPence,
    result: {
      state: 'succeeded',
      output: {
        // Same metadata shape as the AssemblyAI adapter, so word timing reads either.
        metadata: {
          model: TRANSCRIPTION_MODEL,
          text: verbose.text ?? '',
          words: (verbose.words ?? []).map((w) => ({
            text: w.word,
            startSec: w.start,
            endSec: w.end,
          })),
          languageCode: verbose.language ?? null,
          audioDurationSec: typeof verbose.duration === 'number' ? verbose.duration : null,
          costPence,
        },
      },
    },
  };
}
