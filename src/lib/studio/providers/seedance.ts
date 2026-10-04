import { createHash } from 'node:crypto';
import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import { httpJson } from './http';
import type {
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
import type { PlanTier } from './router';

// BACKLOG 20.23 — BytePlus ModelArk Seedance (Layer 3 AI_CLIP; operator decision 2026-10-02: a
// fourth text-to-video provider beside Runway, Luma and Google Veo). Contract read 2026-10-02
// from the BytePlus docs (pages last updated 2026-09-28):
//   https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api  (ModelArk/1520757)
//   https://docs.byteplus.com/en/docs/modelark/get-video-generation-task-api
//   https://docs.byteplus.com/en/docs/modelark/list-video-generation-tasks-api
//   https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api
//   https://docs.byteplus.com/en/docs/modelark/base-url-and-authentication
//   https://docs.byteplus.com/en/docs/modelark/api-key        (keys are per region and project)
//   https://docs.byteplus.com/en/docs/modelark/model-list     (ModelArk/1330310: ids, 4–15 s / 4–30 s,
//                                                              24 fps, RPM + concurrency limits)
//   https://docs.byteplus.com/en/docs/modelark/model-pricing  (ModelArk/1099320: USD / M tokens)
//   https://docs.byteplus.com/en/docs/modelark/error-codes    (ModelArk/1299023)
//   https://docs.byteplus.com/en/docs/modelark/region-availability (ap-southeast-1 = Johor)
//
//   POST   {base}/contents/generations/tasks           Authorization: Bearer <API key>
//          body { model, content: [{ type: "text", text }, { type: "image_url",
//                 image_url: { url }, role: "first_frame" }?], ratio, duration, resolution,
//                 generate_audio, watermark, execution_expires_after, safety_identifier }
//          → { id }
//   GET    {base}/contents/generations/tasks/{id}
//          → { id, model, status: queued|running|cancelled|succeeded|failed (|expired, see the
//              callback list), content?: { video_url }, error?: { code, message } | null,
//              usage?: { completion_tokens, total_tokens }, duration, ratio, resolution }
//   DELETE {base}/contents/generations/tasks/{id}     queued → cancelled; running cannot be cancelled
//   GET    {base}/contents/generations/tasks?page_num=1&page_size=1   (list: the unbilled health check;
//          verified live by the operator 2026-10-02: HTTP 200 { total, items })
//
// Facts that shape this adapter:
//   - Base URL https://ark.ap-southeast.bytepluses.com/api/v3 (ap-southeast-1, Johor, Malaysia).
//     The eu-west-1 (Dublin) region serves only seed-2-0 / seedream text and image models, so
//     Seedance runs in ap-southeast-1. BYTEPLUS_ARK_BASE_URL may point at another region later.
//   - Billing: tokens ≈ duration × width × height × 24 fps / 1024, priced per million tokens;
//     usage.completion_tokens is the billed amount (actual cost reported at poll time). "You are
//     only charged for successfully generated videos" (failed / moderated = free).
//   - generate_audio defaults to true. Our composer mutes generated clips (pipeline/edl.ts), so we
//     send false. The price table does not vary with audio for the 2.x models (only the retired
//     Seedance 1.5 pro was cheaper silent), so this saves no money, only bytes.
//   - video_url is valid for 24 hours (2.5: at most 100 downloads); task records are kept 7 days.
//     It is a plain pre-signed URL (no auth), so Layer 3's normal copy path stores it at once.
//   - 2.x / 2.5 refuse reference images with real human faces
//     (InputImageSensitiveContentDetected.PrivacyInformation → content_policy).
//   - Seedance 1.5 pro (seedance-1-5-pro-251215) is marked Retired in the model list
//     (replacement: dreamina-seedance-2-0-mini-260615), so it is not offered.
//
// UNCONFIRMED (PROGRESS.md 20.23): the error-body envelope (we read { error: { code, message } },
// the shape the task object documents), the list endpoint's page_size range, and the latency.

export const PROVIDER_ID = 'seedance';
export const DEFAULT_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const TASKS_PATH = 'contents/generations/tasks';

export type SeedanceResolution = '480p' | '720p' | '1080p';

export interface SeedanceModelInfo {
  /** LIST price, 480p/720p output, input without video (model-pricing, USD per M tokens). */
  readonly usdPerMillionTokens: number;
  /** LIST price at 1080p, input without video; absent = the model has no 1080p. */
  readonly usdPerMillionTokens1080p?: number;
  /** Output resolutions we may request (4K is documented for 2.0 but never requested). */
  readonly resolutions: readonly SeedanceResolution[];
  readonly minSec: number;
  readonly maxSec: number;
  /** 2.5 image-to-video keeps the first frame's ratio: `ratio` must be "adaptive". */
  readonly imageToVideoAdaptiveOnly: boolean;
}

/**
 * Model ids and LIST prices from the pricing page (ModelArk/1099320, read 2026-10-02 and again
 * 2026-10-04, page last updated 2026-09-28 01:30). Budgets use list prices so they still hold when
 * a promotion ends. PROMO (enterprise users only, until 2026-10-07 14:00 UTC+8): 2.0 mini 60% off,
 * 2.0 fast 25% off; Studio's estimates ignore it on purpose.
 * 21.3 (read 2026-10-04): 1080p is priced separately, "For 1080p outputs: Input without video:
 * 7.7" (2.0) and 11.7 (2.5); the create-task page lists 1080p for 2.5 and 2.0 ("Default 720p;
 * supports 480p, 720p, 1080p, and 4k") but not for 2.0 fast or mini ("supports 480p and 720p").
 * Pricing-page example (2.0, 1080p 16:9, 5 s): $1.87 a video, $0.37 a second. A secondary source
 * (framesurfer, September 2026: 2.0 ≈ $0.15/s at 720p, $0.37/s at 1080p; mini ≈ $0.08/s at 720p)
 * agrees with the official page.
 */
export const SEEDANCE_MODELS = {
  'dreamina-seedance-2-0-mini-260615': {
    usdPerMillionTokens: 3.5,
    resolutions: ['480p', '720p'],
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-0-fast-260128': {
    usdPerMillionTokens: 5.6,
    resolutions: ['480p', '720p'],
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-0-260128': {
    usdPerMillionTokens: 7.0,
    usdPerMillionTokens1080p: 7.7,
    resolutions: ['480p', '720p', '1080p'],
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-5-260628': {
    usdPerMillionTokens: 10.7,
    usdPerMillionTokens1080p: 11.7,
    resolutions: ['480p', '720p', '1080p'],
    minSec: 4,
    maxSec: 30,
    imageToVideoAdaptiveOnly: true,
  },
} as const satisfies Record<string, SeedanceModelInfo>;
export type SeedanceModel = keyof typeof SEEDANCE_MODELS;

/**
 * DECISION (PROGRESS 20.23): Dreamina Seedance 2.0 mini is the default model — generally
 * available (no preview label in the model list), the cheapest current model ($0.0756 per second
 * at 720p list, 2.0 fast is $0.121) and BytePlus's named replacement for the retired 1.5 pro.
 * Since 21.3 it serves BASIC (and any request without a plan tier) and is the fallback when the
 * full model is not activated or out of credit. Shots longer than 15 s use the long model (2.5,
 * up to 30 s): see SeedanceAdapter.modelFor.
 * DECISION (PROGRESS 21.3, operator decision 2026-10-04 "tiered video models"): STANDARD,
 * PLUS and ENTERPRISE use the full Seedance 2.0 model (DEFAULT_SEEDANCE_FULL_MODEL); the plan
 * tier's resolution (pipeline/clip-budget.ts: STANDARD 720p, PLUS / ENTERPRISE 1080p) comes on
 * the request.
 */
export const DEFAULT_SEEDANCE_MODEL: SeedanceModel = 'dreamina-seedance-2-0-mini-260615';
export const DEFAULT_SEEDANCE_FULL_MODEL: SeedanceModel = 'dreamina-seedance-2-0-260128';
export const DEFAULT_SEEDANCE_LONG_MODEL: SeedanceModel = 'dreamina-seedance-2-5-260628';

/** Which configured model each plan tier uses for shots up to 15 s (21.3). */
export const SEEDANCE_TIER_MODEL: Readonly<Record<PlanTier, 'default' | 'full'>> = {
  BASIC: 'default',
  STANDARD: 'full',
  PLUS: 'full',
  ENTERPRISE: 'full',
};

/**
 * How long the adapter skips the full model after BytePlus refused it as not activated or out of
 * credit (21.3 Mini fallback), so later shots do not pay a refused request each. The refusal is
 * free (only successful videos are billed); 10 minutes lets a top-up or activation take effect soon.
 */
export const FULL_MODEL_RETRY_AFTER_MS = 10 * 60_000;
/** Refusals that send a full-model shot to the default model instead (account, not input). */
const FULL_MODEL_FALLBACK_CLASSES: ReadonlySet<string> = new Set<ProviderErrorClass>([
  'auth',
  'insufficient_credits',
]);

/** The default output resolution; the plan tier asks for 480p / 720p / 1080p (request.resolution). */
export const RESOLUTION = '720p';
const FPS = 24;
const TOKENS_PER_PIXEL_FRAME = 1 / 1024;

export type SeedanceRatio = '16:9' | '9:16' | '1:1' | '3:4';
/** Seedance has no 4:5; 3:4 is the nearest portrait ratio and the composer's "cover" crops it. */
export const SEEDANCE_RATIO: Record<AspectRatio, SeedanceRatio> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '1:1',
  '4:5': '3:4',
};
/** 720p frame sizes (create-task "Width and height pixel values", same for 2.0 and 2.5). */
const FRAME_720P: Record<SeedanceRatio, readonly [number, number]> = {
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '1:1': [960, 960],
  '3:4': [834, 1112],
};
/** "adaptive" picks the first frame's ratio; estimate with the largest 720p frame (4:3, 3:4). */
const ADAPTIVE_FRAME_PIXELS = 834 * 1112;
/**
 * 480p frame sizes (create-task "Width and height pixel values", read 2026-10-03): the 2.0 series
 * (mini, fast, 2.0) and 2.5 differ only at 16:9 / 9:16. Every listed model offers 480p.
 */
const FRAME_480P_2_0: Record<SeedanceRatio, readonly [number, number]> = {
  '16:9': [864, 496],
  '9:16': [496, 864],
  '1:1': [640, 640],
  '3:4': [560, 752],
};
const FRAME_480P_2_5: Record<SeedanceRatio, readonly [number, number]> = {
  '16:9': [854, 480],
  '9:16': [480, 854],
  '1:1': [640, 640],
  '3:4': [560, 752],
};
/** The largest documented 480p frame (21:9, 992 × 432) for "adaptive" estimates. */
const ADAPTIVE_480P_PIXELS = 992 * 432;
/**
 * 1080p frame sizes (create-task "Width and height pixel values", read 2026-10-04): the same for
 * 2.5 and the 2.0 series ("Seedance 2.0 fast and Seedance 2.0 mini are not supported").
 */
const FRAME_1080P: Record<SeedanceRatio, readonly [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1440, 1440],
  '3:4': [1248, 1664],
};
/** The largest documented 1080p frame (21:9, 2206 × 946) for "adaptive" estimates. */
const ADAPTIVE_1080P_PIXELS = 2206 * 946;

/** Billed pixels per frame for a model, ratio and resolution. */
export function seedanceFramePixels(
  model: SeedanceModel,
  ratio: SeedanceRatio | 'adaptive',
  resolution: SeedanceResolution,
): number {
  if (resolution === '1080p') {
    return ratio === 'adaptive'
      ? ADAPTIVE_1080P_PIXELS
      : FRAME_1080P[ratio][0] * FRAME_1080P[ratio][1];
  }
  if (resolution === '720p') {
    return ratio === 'adaptive'
      ? ADAPTIVE_FRAME_PIXELS
      : FRAME_720P[ratio][0] * FRAME_720P[ratio][1];
  }
  if (ratio === 'adaptive') return ADAPTIVE_480P_PIXELS;
  const table = model === 'dreamina-seedance-2-5-260628' ? FRAME_480P_2_5 : FRAME_480P_2_0;
  return table[ratio][0] * table[ratio][1];
}

// Not a documented limit (BytePlus recommends ≤ 1,000 English words): a local guard only.
const MAX_PROMPT_CHARS = 5000;
// No latency is documented; a 720p clip typically takes one to two minutes (UNCONFIRMED).
const TYPICAL_LATENCY_SEC = 120;
const TIMEOUT_MS = 30_000;
/**
 * The documented minimum (3600 s; default 172800). Our poller gives up after 15 minutes
 * (pipeline/deps.ts providerTimeoutMs), so a task still queued an hour later expires instead of
 * producing (and billing) a clip nobody will collect.
 */
const EXECUTION_EXPIRES_AFTER_SEC = 3600;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const SEEDANCE_KEY_ENV = 'BYTEPLUS_API_KEY';
export const SEEDANCE_MODEL_ENV = 'SEEDANCE_MODEL';
export const SEEDANCE_FULL_MODEL_ENV = 'SEEDANCE_FULL_MODEL';
export const SEEDANCE_LONG_MODEL_ENV = 'SEEDANCE_LONG_MODEL';
export const SEEDANCE_BASE_URL_ENV = 'BYTEPLUS_ARK_BASE_URL';

export function isSeedanceModel(value: string): value is SeedanceModel {
  return Object.hasOwn(SEEDANCE_MODELS, value);
}

/** An https ModelArk data-plane URL (`https://ark.<region>.bytepluses.com/api/v3`). */
export function isArkBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    /^ark\.[a-z0-9-]+\.bytepluses\.com$/.test(url.hostname) &&
    url.pathname.replace(/\/+$/, '') === '/api/v3' &&
    !url.search &&
    !url.hash
  );
}

export interface SeedanceAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  /** BASIC's model and the fallback when the full model is refused (default 2.0 mini). */
  model?: SeedanceModel;
  /** STANDARD / PLUS / ENTERPRISE's model (21.3, default the full Seedance 2.0). */
  fullModel?: SeedanceModel;
  longModel?: SeedanceModel;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Told when the full model is refused and the default model takes over (21.3). */
  onFullModelFallback?: (event: SeedanceFallbackEvent) => void;
}

export interface SeedanceFallbackEvent {
  from: SeedanceModel;
  to: SeedanceModel;
  /** The refusal's class (`auth` or `insufficient_credits`). */
  errorClass: string;
  message: string;
}

function envModel(env: Record<string, string | undefined>, name: string): SeedanceModel | '' {
  const value = env[name]?.trim() ?? '';
  if (value && !isSeedanceModel(value)) {
    const known = Object.keys(SEEDANCE_MODELS).join(', ');
    throw new ConfigurationError(`${name} must be one of ${known} (or empty)`);
  }
  return value as SeedanceModel | '';
}

/**
 * SEEDANCE_MODEL, SEEDANCE_FULL_MODEL, SEEDANCE_LONG_MODEL and BYTEPLUS_ARK_BASE_URL (all
 * optional). An unknown value is a configuration error, never a silent default: a model without a
 * price row could not be budget-checked, and the key must only ever be sent to a ModelArk host.
 * SEEDANCE_FULL_MODEL=dreamina-seedance-2-0-mini-260615 puts every tier back on Mini (21.3).
 */
export function seedanceOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<SeedanceAdapterOptions, 'model' | 'fullModel' | 'longModel' | 'baseUrl'> {
  const model = envModel(env, SEEDANCE_MODEL_ENV);
  const fullModel = envModel(env, SEEDANCE_FULL_MODEL_ENV);
  const longModel = envModel(env, SEEDANCE_LONG_MODEL_ENV);
  const baseUrl = env[SEEDANCE_BASE_URL_ENV]?.trim() ?? '';
  if (baseUrl && !isArkBaseUrl(baseUrl)) {
    throw new ConfigurationError(
      `${SEEDANCE_BASE_URL_ENV} must be https://ark.<region>.bytepluses.com/api/v3 (or empty)`,
    );
  }
  return {
    ...(model && { model }),
    ...(fullModel && { fullModel }),
    ...(longModel && { longModel }),
    ...(baseUrl && { baseUrl: baseUrl.replace(/\/+$/, '') }),
  };
}

/** The whole seconds a model renders for a shot: next whole second up, at least its minimum. */
export function seedanceDuration(durationSec: number, model: SeedanceModel): number {
  return Math.max(SEEDANCE_MODELS[model].minSec, Math.ceil(durationSec));
}

/** Billed tokens (model-pricing formula) for `seconds` of output at a frame size. */
export function seedanceTokens(seconds: number, pixels: number): number {
  return seconds * pixels * FPS * TOKENS_PER_PIXEL_FRAME;
}

// --- error classification -------------------------------------------------------------------
// ModelArk error codes (error-codes page): the code decides, the HTTP status is the fallback.

const ACCOUNT_AUTH =
  /^(?:AuthenticationError|InvalidAccountStatus|AccessDenied|InvalidSubscription|ModelNotOpen|OperationDenied\.(?:ServiceNotOpen|PermissionDenied)|InvalidEndpointOrModel\..+)$/;
const ACCOUNT_OVERDUE = /^(?:AccountOverdueError|OperationDenied\.ServiceOverdue)$/;
const RATE_LIMITED =
  /^(?:RateLimitExceeded\..+|Model\w*RateLimitExceeded|APIAccount\w*RateLimitExceeded|AccountRateLimitExceeded|RequestBurstTooFast|InflightBatchsizeExceeded)$/;
const PROVIDER_DOWN = /^(?:ServerOverloaded|InternalServiceError|InvalidEndpoint\.ClosedEndpoint)$/;
const BAD_INPUT = /^(?:InvalidParameter|MissingParameter|InvalidImageURL|InvalidArgumentError)\b/;
/** BytePlus wording for an empty balance (the account is "in arrears" / "overdue"). */
const ARREARS_TEXT =
  /overdue (?:balance|bill)|in arrears|balance (?:is )?(?:insufficient|below zero)/i;

/** Classify a documented ModelArk error code; undefined when the code is not one we know. */
export function classifyArkCode(code: string, message: string): ErrorClassification | undefined {
  if (code.includes('SensitiveContentDetected')) {
    // Input/output moderation, copyright (.PolicyViolation) and real faces (.PrivacyInformation).
    return { errorClass: 'content_policy', retryable: false };
  }
  if (ACCOUNT_AUTH.test(code)) return { errorClass: 'auth', retryable: false };
  if (ACCOUNT_OVERDUE.test(code)) return { errorClass: 'insufficient_credits', retryable: false };
  // "reached the set inference limit … the model service has been paused" (Safe Experience Mode).
  if (code === 'SetLimitExceeded') return { errorClass: 'account_limit', retryable: false };
  if (code === 'QuotaExceeded') {
    if (/free trial/i.test(message))
      return { errorClass: 'insufficient_credits', retryable: false };
    if (/5-hour|weekly|monthly/i.test(message)) {
      return { errorClass: 'account_limit', retryable: false };
    }
    // "The number of tasks in the queued state … has exceeded the limit. Please try again later."
    return { errorClass: 'rate_limited', retryable: true };
  }
  if (RATE_LIMITED.test(code)) return { errorClass: 'rate_limited', retryable: true };
  if (PROVIDER_DOWN.test(code)) return { errorClass: 'provider_unavailable', retryable: true };
  if (BAD_INPUT.test(code)) return { errorClass: 'invalid_request', retryable: false };
  return undefined;
}

/**
 * 20.19 (shared rule, provider-errors.ts): out-of-credit (or arrears) wording on what would
 * otherwise be an input error or an unknown failure is an ACCOUNT problem, so failover, the
 * account hold and the operator alert apply.
 */
export function withOutOfCredit(
  classification: ErrorClassification,
  message: string,
): ErrorClassification {
  return (classification.errorClass === 'invalid_request' ||
    classification.errorClass === 'unknown') &&
    (isOutOfCreditMessage(message) || ARREARS_TEXT.test(message))
    ? { errorClass: 'insufficient_credits', retryable: false }
    : classification;
}

interface ArkError {
  code?: string;
  message?: string;
  type?: string;
}

function arkError(body: unknown): ArkError | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === 'object') return error as ArkError;
  }
  return undefined;
}

/** HTTP-level errors: the documented code first, then the status. */
export function classifySeedanceHttpError(status: number, body: unknown): ErrorClassification {
  const error = arkError(body);
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const byCode = code ? classifyArkCode(code, message) : undefined;
  return withOutOfCredit(byCode ?? classifyHttpStatus(status), message);
}

/** A failed task's `error` object (no HTTP status: the code alone decides). */
export function classifyTaskError(error: ArkError): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  const classified = withOutOfCredit(
    classifyArkCode(code, message) ?? { errorClass: 'unknown', retryable: false },
    message,
  );
  return { class: classified.errorClass, retryable: classified.retryable };
}

function seedanceErrorMessage(body: unknown): string | undefined {
  const error = arkError(body);
  if (error) return `${error.code ?? error.type ?? 'error'}: ${error.message ?? ''}`.trim();
  return typeof body === 'string' ? body : undefined;
}

type TaskStatus = 'queued' | 'running' | 'cancelled' | 'succeeded' | 'failed' | 'expired';

interface SeedanceTask {
  id?: string;
  model?: string;
  status?: TaskStatus | string;
  content?: { video_url?: string; last_frame_url?: string } | null;
  error?: ArkError | null;
  usage?: { completion_tokens?: number; total_tokens?: number } | null;
  duration?: number;
  ratio?: string;
  resolution?: string;
}

type VideoRequest = Extract<ProviderRequest, { capability: 'text_to_video' | 'image_to_video' }>;

function isVideoRequest(request: ProviderRequest): request is VideoRequest {
  return request.capability === 'text_to_video' || request.capability === 'image_to_video';
}

/**
 * The plan tier's resolution (request.resolution: BASIC 480p, STANDARD 720p, PLUS / ENTERPRISE
 * 1080p), else 720p, capped at the best the model offers: a 1080p shot that lands on 2.0 mini or
 * fast (the Mini fallback, or SEEDANCE_FULL_MODEL set to one of them) is asked for at 720p.
 */
export function seedanceResolution(
  request: VideoRequest,
  model: SeedanceModel,
): SeedanceResolution {
  const wanted: SeedanceResolution = request.resolution ?? RESOLUTION;
  const offered: readonly SeedanceResolution[] = SEEDANCE_MODELS[model].resolutions;
  if (offered.includes(wanted)) return wanted;
  return offered.includes(RESOLUTION) ? RESOLUTION : (offered[0] ?? RESOLUTION);
}

/** List USD per million tokens for a model at a resolution (input without video). */
export function seedanceUsdPerMillionTokens(
  model: SeedanceModel,
  resolution: SeedanceResolution,
): number {
  const info: SeedanceModelInfo = SEEDANCE_MODELS[model];
  if (resolution === '1080p' && info.usdPerMillionTokens1080p !== undefined) {
    return info.usdPerMillionTokens1080p;
  }
  return info.usdPerMillionTokens;
}

function isSeedanceResolution(value: unknown): value is SeedanceResolution {
  return value === '480p' || value === '720p' || value === '1080p';
}

export class SeedanceAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_to_video', 'image_to_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;
  readonly model: SeedanceModel;
  readonly fullModel: SeedanceModel;
  readonly longModel: SeedanceModel;
  readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Until when the full model is skipped after a not-activated / out-of-credit refusal. */
  private fullModelSkippedUntil = 0;

  constructor(private readonly options: SeedanceAdapterOptions) {
    this.model = options.model ?? DEFAULT_SEEDANCE_MODEL;
    this.fullModel = options.fullModel ?? DEFAULT_SEEDANCE_FULL_MODEL;
    this.longModel = options.longModel ?? DEFAULT_SEEDANCE_LONG_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<T>(
      `${this.baseUrl}/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: seedanceErrorMessage,
        classifyError: classifySeedanceHttpError,
      },
    );
  }

  /** The model a plan tier uses for shots up to 15 s (21.3); no tier = the default model. */
  tierModel(planTier?: PlanTier): SeedanceModel {
    return planTier && SEEDANCE_TIER_MODEL[planTier] === 'full' ? this.fullModel : this.model;
  }

  /** True while the full model is skipped after a refusal (21.3 Mini fallback). */
  fullModelSkipped(): boolean {
    return this.fullModel !== this.model && this.now() < this.fullModelSkippedUntil;
  }

  /**
   * The model for a shot (21.3): the plan tier's model (BASIC 2.0 mini; STANDARD, PLUS and
   * ENTERPRISE the full 2.0, or Mini while the full model is skipped after a refusal), and the
   * long model (2.5 by default) only for shots longer than that model can render (over 15 s, up to
   * 30 s). Undefined when no configured model can render the shot.
   */
  modelFor(durationSec: number, planTier?: PlanTier): SeedanceModel | undefined {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return undefined;
    const seconds = Math.ceil(durationSec);
    const fits = (model: SeedanceModel) => seconds <= SEEDANCE_MODELS[model].maxSec;
    const tierModel = this.tierModel(planTier);
    const primary =
      tierModel === this.fullModel && this.fullModelSkipped() ? this.model : tierModel;
    return [primary, this.longModel].find(fits);
  }

  private modelForRequest(request: VideoRequest): SeedanceModel | undefined {
    return this.modelFor(request.durationSec, request.planTier);
  }

  /** Router hint: shots longer than every configured model's maximum go to the next candidate. */
  supportsRequest(request: ProviderRequest): boolean {
    return isVideoRequest(request) && this.modelForRequest(request) !== undefined;
  }

  private ratioFor(request: VideoRequest, model: SeedanceModel): SeedanceRatio | 'adaptive' {
    if (
      request.capability === 'image_to_video' &&
      SEEDANCE_MODELS[model].imageToVideoAdaptiveOnly
    ) {
      return 'adaptive';
    }
    return SEEDANCE_RATIO[request.aspectRatio];
  }

  private usdForTokens(
    tokens: number,
    model: SeedanceModel,
    resolution: SeedanceResolution,
  ): number {
    return (tokens * seedanceUsdPerMillionTokens(model, resolution)) / 1_000_000;
  }

  private costPenceFor(request: VideoRequest, model: SeedanceModel): number {
    const resolution = seedanceResolution(request, model);
    const pixels = seedanceFramePixels(model, this.ratioFor(request, model), resolution);
    const tokens = seedanceTokens(seedanceDuration(request.durationSec, model), pixels);
    return usdToPence(this.usdForTokens(tokens, model, resolution), this.options.usdToGbpRate);
  }

  /** List-price estimate for the model and resolution the shot will be sent with. */
  estimateCostPence(request: ProviderRequest): number {
    if (!isVideoRequest(request)) return 0;
    const model = this.modelForRequest(request);
    return model ? this.costPenceFor(request, model) : 0;
  }

  /** The create-task body for a shot (exported shape for tests and reviews). */
  buildBody(request: ProviderRequest): Record<string, unknown> {
    if (!isVideoRequest(request)) {
      throw this.invalid(`Seedance adapter does not support ${request.capability}`);
    }
    const model = this.modelForRequest(request);
    if (!model) {
      throw this.invalid(
        `Seedance clips cover shots up to ${SEEDANCE_MODELS[this.longModel].maxSec}s (got ${request.durationSec})`,
      );
    }
    return this.bodyFor(request, model);
  }

  private bodyFor(request: VideoRequest, model: SeedanceModel): Record<string, unknown> {
    const prompt = request.prompt.trim();
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Seedance prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
    if (request.capability === 'image_to_video') {
      content.push({
        type: 'image_url',
        image_url: { url: this.imageUrl(request.imageUrl) },
        role: 'first_frame',
      });
    }
    return {
      model,
      content,
      ratio: this.ratioFor(request, model),
      duration: seedanceDuration(request.durationSec, model),
      resolution: seedanceResolution(request, model),
      // The composer mutes generated clips (pipeline/edl.ts); our narration and music carry sound.
      generate_audio: false,
      watermark: false,
      execution_expires_after: EXECUTION_EXPIRES_AFTER_SEC,
      // Docs: a fixed per-end-user id (≤ 64 chars), hashed so no tenant id leaves Studio.
      safety_identifier: createHash('sha256').update(request.organisationId).digest('hex'),
    };
  }

  /**
   * 21.3 Mini fallback: when the full model is refused as not activated (ModelNotOpen and the
   * other `auth` codes) or out of credit (`insufficient_credits`: arrears, a used-up resource
   * pack for that model), the same shot is sent to the default model (2.0 mini, at most 720p)
   * before the router fails over to Kling. Only if Mini is refused too does the error reach the
   * router (account hold, operator alert, next provider). The full model is then skipped for
   * FULL_MODEL_RETRY_AFTER_MS. Input, moderation and rate-limit errors never fall back.
   */
  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    const body = this.buildBody(request);
    try {
      return await this.submitWith(request, body);
    } catch (err) {
      if (!isVideoRequest(request) || !(err instanceof ProviderError)) throw err;
      const from = this.modelForRequest(request);
      const fallback = from ? this.fallbackFor(from, request, err) : undefined;
      if (!from || !fallback) throw err;
      this.fullModelSkippedUntil = this.now() + FULL_MODEL_RETRY_AFTER_MS;
      this.options.onFullModelFallback?.({
        from,
        to: fallback,
        errorClass: err.errorClass,
        message: err.message,
      });
      return this.submitWith(request, this.bodyFor(request, fallback), fallback);
    }
  }

  /** The default model when a full-model refusal should fall back to it (21.3), else undefined. */
  private fallbackFor(
    model: SeedanceModel,
    request: VideoRequest,
    err: ProviderError,
  ): SeedanceModel | undefined {
    if (model !== this.fullModel || this.fullModel === this.model) return undefined;
    if (!FULL_MODEL_FALLBACK_CLASSES.has(err.errorClass)) return undefined;
    const fits = Math.ceil(request.durationSec) <= SEEDANCE_MODELS[this.model].maxSec;
    return fits ? this.model : undefined;
  }

  private async submitWith(
    request: ProviderRequest,
    body: Record<string, unknown>,
    model?: SeedanceModel,
  ): Promise<ProviderSubmitResult> {
    const { body: created } = await this.request<{ id?: unknown }>(TASKS_PATH, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const id = created && typeof created.id === 'string' ? created.id : '';
    if (!TASK_ID.test(id)) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Seedance did not return a task id',
      );
    }
    const estimatedCostPence =
      model && isVideoRequest(request)
        ? this.costPenceFor(request, model)
        : this.estimateCostPence(request);
    return {
      providerJobId: id,
      estimatedCostPence,
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  private async getTask(providerJobId: string): Promise<SeedanceTask | 'not_found'> {
    try {
      const { body } = await this.request<SeedanceTask>(`${TASKS_PATH}/${providerJobId}`, {
        method: 'GET',
      });
      return body;
    } catch (err) {
      // Task records are kept for 7 days; an unknown id is gone (or never existed).
      if (err instanceof ProviderError && err.details?.status === 404) return 'not_found';
      throw err;
    }
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    if (!TASK_ID.test(providerJobId)) {
      return {
        state: 'failed',
        error: { class: 'invalid_request', message: 'Not a Seedance task id', retryable: false },
      };
    }
    const task = await this.getTask(providerJobId);
    if (task === 'not_found') {
      return {
        state: 'failed',
        error: { class: 'result_expired', message: 'Seedance task not found', retryable: true },
      };
    }
    switch (task.status) {
      case 'queued':
      case 'running':
        return { state: 'running' };
      case 'succeeded':
        return this.succeeded(providerJobId, task);
      case 'failed':
        return {
          state: 'failed',
          error: {
            ...classifyTaskError(task.error ?? {}),
            message: `${task.error?.code ?? 'failed'}: ${task.error?.message ?? 'Seedance generation failed'}`,
          },
        };
      case 'expired':
        return {
          state: 'failed',
          error: {
            class: 'timeout',
            message: `Seedance task expired after ${EXECUTION_EXPIRES_AFTER_SEC}s in the queue`,
            retryable: true,
          },
        };
      case 'cancelled':
        return {
          state: 'failed',
          error: { class: 'unknown', message: 'Seedance task was cancelled', retryable: false },
        };
      default:
        return {
          state: 'failed',
          error: {
            class: 'unknown',
            message: `Seedance task in an unknown state: ${String(task.status)}`,
            retryable: true,
          },
        };
    }
  }

  private succeeded(providerJobId: string, task: SeedanceTask): ProviderPollResult {
    const url = task.content?.video_url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: 'Seedance task succeeded without a video URL',
          retryable: true,
        },
      };
    }
    const model = typeof task.model === 'string' && isSeedanceModel(task.model) ? task.model : null;
    const tokens = task.usage?.completion_tokens;
    // The task reports its resolution; 1080p has its own token rate (21.3).
    const resolution = isSeedanceResolution(task.resolution) ? task.resolution : RESOLUTION;
    // usage.completion_tokens is the billed amount ("the basis for billing reconciliation").
    const costPence =
      model && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
        ? usdToPence(this.usdForTokens(tokens, model, resolution), this.options.usdToGbpRate)
        : undefined;
    return {
      state: 'succeeded',
      output: {
        url,
        metadata: {
          taskId: providerJobId,
          model: task.model,
          resolution: task.resolution ?? RESOLUTION,
          ratio: task.ratio,
          durationSec: task.duration,
          completionTokens: tokens,
          ...(costPence !== undefined && { costPence }),
          audio: 'none (generate_audio false)',
          // Docs: "Video URLs are valid for 24 hours"; Layer 3 copies the clip at once.
          urlExpiresWithinHours: 24,
        },
      },
    };
  }

  /**
   * DELETE cancels only a QUEUED task (docs table: running → "No"). A running task runs to
   * completion and may be billed, so that case is NotImplementedError (the job keeps its cost
   * reservation, as for Luma and Veo). A task already finished needs nothing.
   */
  async cancel(providerJobId: string): Promise<void> {
    if (!TASK_ID.test(providerJobId)) throw this.invalid('Not a Seedance task id');
    const task = await this.getTask(providerJobId);
    if (task === 'not_found') return;
    if (task.status === 'running') {
      throw new NotImplementedError(
        `Seedance cannot cancel a running task; ${providerJobId} runs to completion`,
      );
    }
    if (task.status !== 'queued') return;
    await this.request<unknown>(`${TASKS_PATH}/${providerJobId}`, { method: 'DELETE' });
  }

  /** The list endpoint (one row): unbilled, and it proves the key and region. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.request<unknown>(`${TASKS_PATH}?page_num=1&page_size=1`, { method: 'GET' });
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }

  /** Image-to-video: ModelArk fetches the first frame itself from a public https URL. */
  private imageUrl(imageUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw this.invalid('Seedance source frame URL is not a URL');
    }
    if (parsed.protocol !== 'https:')
      throw this.invalid('Seedance source frames must be https URLs');
    return parsed.href;
  }

  private invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
