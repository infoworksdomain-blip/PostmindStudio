import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import { httpJson } from './http';
import type {
  ActorVideoRequest,
  AspectRatio,
  ProviderAdapter,
  ProviderCapability,
  ProviderErrorClass,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import { usdToPence } from './pricing';
import {
  classifyHttpStatus,
  isOutOfCreditMessage,
  providerError,
  type ErrorClassification,
} from './provider-errors';

// BACKLOG 20.20 — Google Veo 3.1 through the Gemini API (Layer 3 AI_CLIP; operator decision
// 2026-10-02: a third text-to-video provider after Runway and Luma, since OpenAI's Sora API was
// discontinued on 2026-09-24). Contract read 2026-10-02 from:
//   https://ai.google.dev/gemini-api/docs/video            (Veo 3.1 = video with native audio)
//   https://ai.google.dev/gemini-api/docs/veo              (REST samples, parameter table,
//                                                            limitations, model versions)
//   https://ai.google.dev/api/models#v1beta.models.predictLongRunning
//   https://ai.google.dev/api/batch-api#Operation          (Operation: name, done, error|response)
//   https://ai.google.dev/gemini-api/docs/pricing#veo-3.1  (per second of video, USD)
//   https://ai.google.dev/gemini-api/docs/rate-limits      (429 RESOURCE_EXHAUSTED, spend limits)
//   https://ai.google.dev/gemini-api/docs/troubleshooting  (402 Prepay depleted; retry 429/5xx)
//   https://ai.google.dev/gemini-api/docs/billing          (Veo has no free tier: billing needed)
//   https://github.com/googleapis/js-genai src/converters/_models_converters.ts (official SDK's
//     REST field mapping, read the same day)
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
//        header x-goog-api-key, body { instances: [{ prompt, image? }], parameters: { … } }
//        → Operation { name: "models/{model}/operations/{id}" }
//   GET  https://generativelanguage.googleapis.com/v1beta/{operation name}
//        → { done, error?: Status { code, message }, response?: { generateVideoResponse: {
//              generatedSamples: [{ video: { uri } }], raiMediaFilteredCount?,
//              raiMediaFilteredReasons? } } }
//   The video uri is downloaded with the same x-goog-api-key header, following redirects
//   (docs: `curl -L -H "x-goog-api-key: …" "${video_uri}"`): see fetchOutput().
//   GET  https://generativelanguage.googleapis.com/v1beta/models/{model} (models.get) is the
//        unbilled health check.
//
// Facts that shape this adapter (docs/veo "Veo API parameters", "Model features", "Limitations"):
//   - aspectRatio "16:9" | "9:16"; durationSeconds 4, 6 or 8; resolution 720p (default) —
//     1080p/4k only at 8 s, so we always ask for 720p (and pay the 720p rate).
//   - Audio is generated natively and is "always on". The SDK refuses `generateAudio` in Gemini
//     API mode ("only supported in … Agent Platform mode"), so it cannot be switched off here.
//     That is fine: the composer mutes every generated clip (pipeline/edl.ts: VideoAsset volume 0
//     unless an uploaded clip keeps its own sound) and our narration + music carry the audio.
//   - personGeneration: text-to-video "allow_all" only; image-to-video "allow_adult" only; and
//     "In EU, UK, CH, MENA locations, allow_adult is the only allowed value". See
//     personGenerationFor() and VEO_PERSON_GENERATION.
//   - "Generated videos are stored on the server for 2 days" — Layer 3 copies the clip into our
//     assets bucket as soon as the operation is done (generate-asset.ts recordAsset).
//   - Blocked videos are not charged ("You will only be charged if your video is successfully
//     generated"), so a failure records no cost (tracked.ts default).
//   - SynthID watermark on every video.
//   - No cancel method is documented for Veo operations (cancel() says so, like Luma).
//
// DOC DISCREPANCY: the REST guide's image samples write `image: { inlineData: { mimeType, data } }`
// while the official SDK sends `image: { bytesBase64Encoded, mimeType }` for the Gemini API. We
// follow the SDK (the shape every SDK user sends); flagged in PROGRESS.md as unconfirmed.

// BACKLOG 21.4 (UGC actors, operator request 2026-10-04) adds `actor_video`: a generated actor
// speaks the shot's line, and the clip's NATIVE audio is the narration (the composer keeps it).
// Contract re-read 2026-10-04 from https://ai.google.dev/gemini-api/docs/veo (page updated
// 2026-09-17) and https://ai.google.dev/gemini-api/docs/pricing:
//   - Prompt guide, Dialogue: "Use quotes for specific speech" (example: Man: "…"); the model
//     generates "a synchronized soundtrack". Lip-sync accuracy is NOT documented: quality is
//     judged by the operator on the first real clips (plans/phase-21-ugc.md).
//   - English is "fully supported"; other languages "have not been evaluated" (English only).
//   - `referenceImages`: "up to three asset images of a single person, character, or product",
//     REST { image, referenceType: "asset" } in the instance; durationSeconds "must be 8" with
//     reference images; personGeneration "allow_adult" only with reference images.
//   - `seed` "is also available for Veo 3 models. It doesn't guarantee determinism, but slightly
//     improves it": every clip of a project sends the project's seed.
//   - Audio is "Always on"; "All prices include default video with audio" ($0.10/s Fast 720p).
// The reference image is encoded like the start frame ({ bytesBase64Encoded, mimeType }, the
// official SDK's shape; the REST samples write inlineData): the same DOC DISCREPANCY as above.

export const PROVIDER_ID = 'veo';
export const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const API_HOST = 'generativelanguage.googleapis.com';

/** Pricing page, "Veo 3.1 … video with audio price (default)", Paid Tier, 720p, USD/second. */
export const VEO_MODELS = {
  'veo-3.1-generate-preview': { usdPerSec720p: 0.4 },
  'veo-3.1-fast-generate-preview': { usdPerSec720p: 0.1 },
  'veo-3.1-lite-generate-preview': { usdPerSec720p: 0.05 },
} as const;
export type VeoModel = keyof typeof VEO_MODELS;
/**
 * Default: Veo 3.1 Fast — "ideal for backend services that programmatically generate ads … or
 * apps that need to quickly produce social media content" (docs/veo "Model versions"), at a
 * price close to Runway's (8 s ≈ $0.80 vs gen4.5 ≈ $0.96).
 */
export const DEFAULT_VEO_MODEL: VeoModel = 'veo-3.1-fast-generate-preview';

export const RESOLUTION = '720p';
export const VEO_DURATIONS = [4, 6, 8] as const;
export type VeoDuration = (typeof VEO_DURATIONS)[number];
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 8;
// "Text input 1,024 tokens". Tokens are not counted locally; ~4 characters per English token.
const MAX_PROMPT_CHARS = 4096;
// Docs: "Request latency: Min: 11 seconds; Max: 6 minutes (during peak hours)".
const TYPICAL_LATENCY_SEC = 120;
const TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);

/**
 * Veo renders 16:9 and 9:16 only. 4:5 uses the nearest portrait ratio; 1:1 is equally far from
 * both and uses 16:9. The composer's fit "cover" crops the difference (as with Luma's 4:5).
 */
export const VEO_RATIO: Record<AspectRatio, '16:9' | '9:16'> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '16:9',
  '4:5': '9:16',
};

export type PersonGeneration = 'allow_adult' | 'allow_all';
/**
 * Image-to-video accepts only allow_adult. Text-to-video accepts only allow_all, and the live API
 * refuses allow_adult there ("allow_adult for personGeneration is currently not supported",
 * production staging gate 2026-10-02), so text-to-video sends no personGeneration unless
 * VEO_PERSON_GENERATION is set and Google applies its own default for the server's region
 * (https://ai.google.dev/gemini-api/docs/veo, read 2026-10-02).
 */
export const IMAGE_TO_VIDEO_PERSON_GENERATION: PersonGeneration = 'allow_adult';
/** "Reference images: allow_adult only" (21.4 actor clips with the product image). */
export const REFERENCE_IMAGES_PERSON_GENERATION: PersonGeneration = 'allow_adult';
/** "durationSeconds … must be "8" when using … reference images". */
export const REFERENCE_IMAGES_DURATION: VeoDuration = 8;
/** A spoken line longer than this cannot be said naturally in an 8 s clip. */
export const MAX_SPOKEN_LINE_CHARS = 300;
/** A seed must fit Veo's unsigned 32-bit field; ours never exceed 2^31-1 (ugc/style.ts). */
const MAX_SEED = 2 ** 32 - 1;

/** 21.4: the actor clip's length (8 s whenever the product image is a reference). */
export function actorDuration(request: {
  durationSec: number;
  productImageUrl?: string;
}): VeoDuration {
  return request.productImageUrl ? REFERENCE_IMAGES_DURATION : veoDuration(request.durationSec);
}

/**
 * 21.4: the documented dialogue form (prompt guide: "Use quotes for specific speech"). Double
 * quotes inside the line would close the quote early, so they become single quotes.
 */
export function withDialogue(prompt: string, spokenLine: string): string {
  const line = spokenLine.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return `${prompt.trim()}\nThe person speaks directly to the camera and says: "${line}"`;
}

export function isVeoModel(value: string): value is VeoModel {
  return Object.hasOwn(VEO_MODELS, value);
}

export function isPersonGeneration(value: string): value is PersonGeneration {
  return value === 'allow_adult' || value === 'allow_all';
}

export const VEO_KEY_ENV = 'GOOGLE_GEMINI_API_KEY';
export const VEO_MODEL_ENV = 'VEO_MODEL';
export const VEO_PERSON_GENERATION_ENV = 'VEO_PERSON_GENERATION';

/**
 * VEO_MODEL and VEO_PERSON_GENERATION (both optional). An unknown value is a configuration
 * error, never a silent default: a model without a price row could not be budget-checked.
 */
export function veoOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<VeoAdapterOptions, 'model' | 'personGeneration'> {
  const model = env[VEO_MODEL_ENV]?.trim() ?? '';
  const person = env[VEO_PERSON_GENERATION_ENV]?.trim() ?? '';
  if (model && !isVeoModel(model)) {
    throw new ConfigurationError(
      `${VEO_MODEL_ENV} must be one of ${Object.keys(VEO_MODELS).join(', ')} (or empty)`,
    );
  }
  if (person && !isPersonGeneration(person)) {
    throw new ConfigurationError(
      `${VEO_PERSON_GENERATION_ENV} must be allow_adult or allow_all (or empty)`,
    );
  }
  return {
    ...(model && { model: model as VeoModel }),
    ...(person && { personGeneration: person as PersonGeneration }),
  };
}

/** Shots render at the next supported length up (4, 6 or 8 s); the composer trims the rest. */
export function veoDuration(durationSec: number): VeoDuration {
  return VEO_DURATIONS.find((d) => durationSec <= d) ?? 8;
}

export function personGenerationFor(
  capability: 'text_to_video' | 'image_to_video',
  configured: PersonGeneration | undefined,
): PersonGeneration | undefined {
  return capability === 'image_to_video' ? IMAGE_TO_VIDEO_PERSON_GENERATION : configured;
}

interface GoogleStatus {
  code?: number | string;
  message?: string;
  status?: string;
  details?: unknown[];
}

interface VeoOperation {
  name: string;
  done?: boolean;
  error?: GoogleStatus;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
}

export interface VeoAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  model?: VeoModel;
  personGeneration?: PersonGeneration;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// --- error classification -------------------------------------------------------------------
// HTTP errors carry Google's Status in `error` ({ code, message, status, details }); finished
// operations carry a Status whose `code` is the numeric google.rpc.Code. Messages below are
// matched loosely because the docs do not list exact wording (UNCONFIRMED, see PROGRESS.md).

const SAFETY_TEXT =
  /safety|responsible ai|usage guidelines|prohibited|blocked|violat|sensitive|celebrit|minor/i;
const KEY_TEXT = /api[ _]?key|API_KEY_INVALID|API_KEY_EXPIRED|leaked/i;
const DAILY_OR_SPEND_TEXT = /per ?day|daily|spend|billing tier|spending cap|tier cap|prepay/i;

/** google.rpc.Code numbers (Operation.error.code) by name. */
const RPC_CODE_NAMES: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

function detailsText(details: unknown[] | undefined): string {
  if (!Array.isArray(details)) return '';
  try {
    return JSON.stringify(details);
  } catch {
    return '';
  }
}

/** Classify a Google status by its canonical name plus the message / details text. */
export function classifyGoogleStatus(
  statusName: string,
  message: string,
  details?: unknown[],
): ErrorClassification {
  const text = `${message} ${detailsText(details)}`;
  switch (statusName) {
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
      return { errorClass: 'auth', retryable: false };
    case 'FAILED_PRECONDITION':
      // e.g. billing not enabled / no Prepay credit (docs/billing): an ACCOUNT problem.
      return { errorClass: 'insufficient_credits', retryable: false };
    case 'RESOURCE_EXHAUSTED':
      // Daily quota and spend caps outlast a retry window; per-minute limits do not.
      return DAILY_OR_SPEND_TEXT.test(text)
        ? { errorClass: 'account_limit', retryable: false }
        : { errorClass: 'rate_limited', retryable: true };
    case 'INVALID_ARGUMENT':
      if (KEY_TEXT.test(text)) return { errorClass: 'auth', retryable: false };
      if (SAFETY_TEXT.test(text)) return { errorClass: 'content_policy', retryable: false };
      return { errorClass: 'invalid_request', retryable: false };
    case 'DEADLINE_EXCEEDED':
      return { errorClass: 'timeout', retryable: true };
    case 'INTERNAL':
    case 'UNAVAILABLE':
    case 'ABORTED':
    case 'UNKNOWN':
      return { errorClass: 'provider_unavailable', retryable: true };
    case 'NOT_FOUND':
      return { errorClass: 'result_expired', retryable: true };
    case 'CANCELLED':
      return { errorClass: 'unknown', retryable: false };
    default:
      return SAFETY_TEXT.test(text)
        ? { errorClass: 'content_policy', retryable: false }
        : { errorClass: 'unknown', retryable: false };
  }
}

function googleError(body: unknown): GoogleStatus | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === 'object') return error as GoogleStatus;
  }
  return undefined;
}

/**
 * 20.19 (shared rule, provider-errors.ts): out-of-credit wording on what would otherwise be an
 * input error or an unknown failure is an ACCOUNT problem, so failover, the account hold and the
 * operator alert apply. Veo always refines its HTTP errors, so httpJson's classifyHttpFailure
 * never upgrades them itself; this does the same here.
 */
export function withOutOfCredit(
  classification: ErrorClassification,
  message: string,
): ErrorClassification {
  return (classification.errorClass === 'invalid_request' ||
    classification.errorClass === 'unknown') &&
    isOutOfCreditMessage(message)
    ? { errorClass: 'insufficient_credits', retryable: false }
    : classification;
}

/** HTTP-level errors: the documented status codes, refined by Google's status name. */
export function classifyVeoHttpError(status: number, body: unknown): ErrorClassification {
  const error = googleError(body);
  const message = typeof error?.message === 'string' ? error.message : '';
  return withOutOfCredit(classifyVeoStatus(status, error, message), message);
}

function classifyVeoStatus(
  status: number,
  error: GoogleStatus | undefined,
  message: string,
): ErrorClassification {
  const name = typeof error?.status === 'string' ? error.status : '';
  if (status === 402) return { errorClass: 'insufficient_credits', retryable: false };
  if (status === 401 || status === 403) return classifyGoogleStatus('PERMISSION_DENIED', message);
  if (status === 429) return classifyGoogleStatus('RESOURCE_EXHAUSTED', message, error?.details);
  if (status === 400 && name) return classifyGoogleStatus(name, message, error?.details);
  if (status === 400) return classifyGoogleStatus('INVALID_ARGUMENT', message, error?.details);
  return classifyHttpStatus(status);
}

/** A finished operation's error Status (numeric google.rpc.Code). */
export function classifyOperationError(error: GoogleStatus): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  const name =
    typeof error.code === 'number'
      ? (RPC_CODE_NAMES[error.code] ?? '')
      : typeof error.status === 'string'
        ? error.status
        : String(error.code ?? '');
  const message = error.message ?? '';
  const classified = withOutOfCredit(classifyGoogleStatus(name, message, error.details), message);
  return { class: classified.errorClass, retryable: classified.retryable };
}

function veoErrorMessage(body: unknown): string | undefined {
  const error = googleError(body);
  if (error) return `${error.status ?? error.code ?? 'error'}: ${error.message ?? ''}`.trim();
  return typeof body === 'string' ? body : undefined;
}

const OPERATION_NAME = /^models\/[a-z0-9.-]+\/operations\/[A-Za-z0-9_.-]+$/;

export class VeoAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = [
    'text_to_video',
    'image_to_video',
    'actor_video',
  ];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;
  readonly model: VeoModel;

  private readonly personGeneration: PersonGeneration | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: VeoAdapterOptions) {
    this.model = options.model ?? DEFAULT_VEO_MODEL;
    this.personGeneration = options.personGeneration;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<T>(
      `${BASE_URL}/${path}`,
      {
        ...init,
        headers: { 'x-goog-api-key': this.options.apiKey, 'Content-Type': 'application/json' },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: veoErrorMessage,
        classifyError: classifyVeoHttpError,
      },
    );
  }

  private secondsPence(seconds: number): number {
    return usdToPence(seconds * VEO_MODELS[this.model].usdPerSec720p, this.options.usdToGbpRate);
  }

  /** Router hint: Veo renders at most 8 s, so longer shots go to the next candidate. */
  supportsRequest(request: ProviderRequest): boolean {
    if (request.capability === 'actor_video') {
      return (
        request.durationSec >= MIN_DURATION_SEC &&
        request.durationSec <= MAX_DURATION_SEC &&
        request.spokenLine.trim().length > 0 &&
        request.spokenLine.length <= MAX_SPOKEN_LINE_CHARS &&
        // English only: the docs have not evaluated other languages (21.4).
        /^en(-|$)/i.test(request.languageCode)
      );
    }
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      return false;
    }
    return request.durationSec >= MIN_DURATION_SEC && request.durationSec <= MAX_DURATION_SEC;
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability === 'actor_video') return this.secondsPence(actorDuration(request));
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') return 0;
    return this.secondsPence(veoDuration(request.durationSec));
  }

  /** The predictLongRunning body for a shot (exported shape for tests and reviews). */
  async buildBody(request: ProviderRequest): Promise<Record<string, unknown>> {
    if (request.capability === 'actor_video') return this.buildActorBody(request);
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      throw this.invalid(`Veo adapter does not support ${request.capability}`);
    }
    if (!this.supportsRequest(request)) {
      throw this.invalid(
        `Veo clips cover ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s shots (got ${request.durationSec})`,
      );
    }
    const prompt = request.prompt.trim();
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Veo prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    const instance: Record<string, unknown> = { prompt };
    if (request.capability === 'image_to_video') {
      instance.image = await this.fetchImage(request.imageUrl);
    }
    const person = personGenerationFor(request.capability, this.personGeneration);
    return {
      instances: [instance],
      parameters: {
        aspectRatio: VEO_RATIO[request.aspectRatio],
        // The parameter table writes the values as "4", "6", "8"; the official SDK sends them as
        // JSON numbers (GenerateVideosConfig.durationSeconds: number), which we follow.
        durationSeconds: veoDuration(request.durationSec),
        resolution: RESOLUTION,
        ...(person && { personGeneration: person }),
        sampleCount: 1,
      },
    };
  }

  /**
   * 21.4: a UGC actor clip. The line goes in quotes after the scene; the product image (when
   * chosen) is an "asset" reference image, which fixes the clip at 8 s and allow_adult. Without
   * it this is text-to-video and follows personGenerationFor('text_to_video', …).
   */
  private async buildActorBody(request: ActorVideoRequest): Promise<Record<string, unknown>> {
    if (!this.supportsRequest(request)) {
      throw this.invalid(
        `Veo actor clips need an English line of 1–${MAX_SPOKEN_LINE_CHARS} characters and a ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s shot`,
      );
    }
    const prompt = withDialogue(request.prompt, request.spokenLine);
    if (request.prompt.trim().length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Veo prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    const instance: Record<string, unknown> = { prompt };
    if (request.productImageUrl) {
      instance.referenceImages = [
        { image: await this.fetchImage(request.productImageUrl), referenceType: 'asset' },
      ];
    }
    const person = request.productImageUrl
      ? REFERENCE_IMAGES_PERSON_GENERATION
      : personGenerationFor('text_to_video', this.personGeneration);
    const seed =
      request.seed !== undefined && Number.isInteger(request.seed) && request.seed >= 0
        ? Math.min(MAX_SEED, request.seed)
        : undefined;
    return {
      instances: [instance],
      parameters: {
        aspectRatio: VEO_RATIO[request.aspectRatio],
        durationSeconds: actorDuration(request),
        resolution: RESOLUTION,
        ...(person && { personGeneration: person }),
        ...(seed !== undefined && { seed }),
        sampleCount: 1,
      },
    };
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    const body = await this.buildBody(request);
    const { body: operation } = await this.request<VeoOperation>(
      `models/${this.model}:predictLongRunning`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!operation || typeof operation.name !== 'string' || !OPERATION_NAME.test(operation.name)) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Veo did not return an operation name',
      );
    }
    return {
      providerJobId: operation.name,
      estimatedCostPence: this.estimateCostPence(request),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    if (!OPERATION_NAME.test(providerJobId)) {
      return {
        state: 'failed',
        error: { class: 'invalid_request', message: 'Not a Veo operation name', retryable: false },
      };
    }
    let operation: VeoOperation;
    try {
      ({ body: operation } = await this.request<VeoOperation>(providerJobId, { method: 'GET' }));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) {
        return {
          state: 'failed',
          error: { class: 'result_expired', message: 'Veo operation not found', retryable: true },
        };
      }
      throw err;
    }
    if (!operation.done) return { state: 'running' };
    if (operation.error) {
      return {
        state: 'failed',
        error: {
          ...classifyOperationError(operation.error),
          message: `${operation.error.code ?? 'error'}: ${operation.error.message ?? 'Veo generation failed'}`,
        },
      };
    }
    const result = operation.response?.generateVideoResponse;
    const uri = result?.generatedSamples?.find((s) => typeof s.video?.uri === 'string')?.video?.uri;
    if (!uri) {
      const filtered = (result?.raiMediaFilteredCount ?? 0) > 0;
      const reasons = (result?.raiMediaFilteredReasons ?? []).join('; ');
      return {
        state: 'failed',
        // Blocked videos are not charged (docs/veo "Limitations", pricing note).
        error: filtered
          ? {
              class: 'content_policy',
              message: `Veo safety filter blocked the video${reasons ? `: ${reasons}` : ''}`,
              retryable: false,
            }
          : {
              class: 'unknown',
              message: 'Veo operation finished without a video',
              retryable: true,
            },
      };
    }
    // Billing is per second of the clip we asked for, so the submit-time estimate (reserved in
    // provider_jobs) is the cost; the operation reports no usage to settle it against.
    return {
      state: 'succeeded',
      output: {
        url: uri,
        metadata: {
          operationName: providerJobId,
          model: this.model,
          resolution: RESOLUTION,
          // Muted by the composer, except a UGC actor clip's (21.4): its speech is the narration.
          audio: 'native',
          watermark: 'SynthID',
          // Docs: "Generated videos are stored on the server for 2 days"; Layer 3 copies the
          // clip into our bucket at once (generate-asset.ts recordAsset via fetchOutput).
          urlExpiresWithinHours: 48,
        },
      },
    };
  }

  /**
   * Authenticated download of a Veo output URI (docs: `curl -L -H "x-goog-api-key: …"`). The key
   * is sent only to the Gemini API host; redirects are followed by hand so a redirect to another
   * host (e.g. a storage CDN) never receives the key.
   */
  async fetchOutput(url: string): Promise<Response> {
    let current = new URL(url);
    if (current.protocol !== 'https:' || current.hostname !== API_HOST) {
      throw this.invalid('Veo output URIs must be https://generativelanguage.googleapis.com');
    }
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const withKey = current.hostname === API_HOST;
      const res = await this.fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: withKey ? { 'x-goog-api-key': this.options.apiKey } : {},
      });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      await res.body?.cancel();
      const next = new URL(location, current);
      if (next.protocol !== 'https:')
        throw this.invalid('Veo output redirected to a non-https URL');
      current = next;
    }
    throw providerError(
      PROVIDER_ID,
      { errorClass: 'provider_unavailable', retryable: true },
      `Veo output download exceeded ${MAX_REDIRECTS} redirects`,
    );
  }

  /** No cancel method is documented for Veo operations; the job keeps its cost reservation. */
  async cancel(providerJobId: string): Promise<void> {
    throw new NotImplementedError(
      `Veo documents no cancel for operations; ${providerJobId} runs to completion`,
    );
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.request<unknown>(`models/${this.model}`, { method: 'GET' });
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }

  /** Image-to-video: the Gemini API takes the start frame inline (base64), not as a URL. */
  private async fetchImage(
    imageUrl: string,
  ): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw this.invalid('Veo source frame URL is not a URL');
    }
    if (parsed.protocol !== 'https:') throw this.invalid('Veo source frames must be https URLs');
    let res: Response;
    try {
      res = await this.fetchImpl(parsed.href, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'provider_unavailable', retryable: true },
        `Source frame download failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) throw this.invalid(`Source frame download failed: HTTP ${res.status}`);
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!IMAGE_TYPES.has(mimeType)) {
      await res.body?.cancel();
      throw this.invalid(`Veo source frames must be PNG or JPEG (got ${mimeType || 'unknown'})`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) {
      await res.body?.cancel();
      throw this.invalid(`Veo source frames must be at most ${MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw this.invalid(`Veo source frames must be 1 byte to ${MAX_IMAGE_BYTES} bytes`);
    }
    return { bytesBase64Encoded: Buffer.from(bytes).toString('base64'), mimeType };
  }

  private invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
