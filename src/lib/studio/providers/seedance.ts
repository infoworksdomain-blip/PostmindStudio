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

export interface SeedanceModelInfo {
  /** LIST price, 480p/720p output, input without video (model-pricing, USD per M tokens). */
  readonly usdPerMillionTokens: number;
  readonly minSec: number;
  readonly maxSec: number;
  /** 2.5 image-to-video keeps the first frame's ratio: `ratio` must be "adaptive". */
  readonly imageToVideoAdaptiveOnly: boolean;
}

/**
 * Model ids and LIST prices from the pricing page (2026-10-02). Budgets use list prices so they
 * still hold when a promotion ends. PROMO (enterprise users only, until 2026-10-07 14:00 UTC+8):
 * 2.0 mini 60% off, 2.0 fast 25% off; Studio's estimates ignore it on purpose.
 */
export const SEEDANCE_MODELS = {
  'dreamina-seedance-2-0-mini-260615': {
    usdPerMillionTokens: 3.5,
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-0-fast-260128': {
    usdPerMillionTokens: 5.6,
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-0-260128': {
    usdPerMillionTokens: 7.0,
    minSec: 4,
    maxSec: 15,
    imageToVideoAdaptiveOnly: false,
  },
  'dreamina-seedance-2-5-260628': {
    usdPerMillionTokens: 10.7,
    minSec: 4,
    maxSec: 30,
    imageToVideoAdaptiveOnly: true,
  },
} as const satisfies Record<string, SeedanceModelInfo>;
export type SeedanceModel = keyof typeof SEEDANCE_MODELS;

/**
 * DECISION (PROGRESS 20.23): Dreamina Seedance 2.0 mini is the default for STANDARD — generally
 * available (no preview label in the model list), the cheapest current model ($0.0756 per second
 * at 720p list, 2.0 fast is $0.121) and BytePlus's named replacement for the retired 1.5 pro.
 * Neither page claims a quality difference between mini and fast. Shots longer than 15 s use the
 * long model (2.5, up to 30 s): see SeedanceAdapter.modelFor.
 * DECISION (PROGRESS 20.25, operator decision 2026-10-03 "cheaper videos"): PLUS and ENTERPRISE
 * use the default model too. 2.5 at 720p is $0.231 a second (70p for a 4 s clip), so PLUS's six
 * clips alone would pass its 240p typical cost per video, and any tier's short would pass the
 * 350p default project budget. The long model now serves only shots the default cannot render.
 */
export const DEFAULT_SEEDANCE_MODEL: SeedanceModel = 'dreamina-seedance-2-0-mini-260615';
export const DEFAULT_SEEDANCE_LONG_MODEL: SeedanceModel = 'dreamina-seedance-2-5-260628';

/** The default output resolution; BASIC asks for 480p (request.resolution, 20.25). */
export const RESOLUTION = '720p';
export type SeedanceResolution = '480p' | '720p';
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

/** Billed pixels per frame for a model, ratio and resolution. */
export function seedanceFramePixels(
  model: SeedanceModel,
  ratio: SeedanceRatio | 'adaptive',
  resolution: SeedanceResolution,
): number {
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
  model?: SeedanceModel;
  longModel?: SeedanceModel;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * SEEDANCE_MODEL, SEEDANCE_LONG_MODEL and BYTEPLUS_ARK_BASE_URL (all optional). An unknown value
 * is a configuration error, never a silent default: a model without a price row could not be
 * budget-checked, and the key must only ever be sent to a ModelArk host.
 */
export function seedanceOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<SeedanceAdapterOptions, 'model' | 'longModel' | 'baseUrl'> {
  const model = env[SEEDANCE_MODEL_ENV]?.trim() ?? '';
  const longModel = env[SEEDANCE_LONG_MODEL_ENV]?.trim() ?? '';
  const baseUrl = env[SEEDANCE_BASE_URL_ENV]?.trim() ?? '';
  const known = Object.keys(SEEDANCE_MODELS).join(', ');
  if (model && !isSeedanceModel(model)) {
    throw new ConfigurationError(`${SEEDANCE_MODEL_ENV} must be one of ${known} (or empty)`);
  }
  if (longModel && !isSeedanceModel(longModel)) {
    throw new ConfigurationError(`${SEEDANCE_LONG_MODEL_ENV} must be one of ${known} (or empty)`);
  }
  if (baseUrl && !isArkBaseUrl(baseUrl)) {
    throw new ConfigurationError(
      `${SEEDANCE_BASE_URL_ENV} must be https://ark.<region>.bytepluses.com/api/v3 (or empty)`,
    );
  }
  return {
    ...(model && { model: model as SeedanceModel }),
    ...(longModel && { longModel: longModel as SeedanceModel }),
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

/** 20.25: the requested resolution (480p on BASIC), else 720p; both are offered by every model. */
export function seedanceResolution(request: VideoRequest): SeedanceResolution {
  return request.resolution ?? RESOLUTION;
}

export class SeedanceAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_to_video', 'image_to_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;
  readonly model: SeedanceModel;
  readonly longModel: SeedanceModel;
  readonly baseUrl: string;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: SeedanceAdapterOptions) {
    this.model = options.model ?? DEFAULT_SEEDANCE_MODEL;
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

  /**
   * The model for a shot, on every plan tier (20.25: PLUS and ENTERPRISE no longer use 2.5 for
   * every shot): the default model, and the long model (2.5 by default) only for shots longer
   * than the default can render (over 15 s, up to 30 s). Undefined when no configured model can
   * render the shot.
   */
  modelFor(durationSec: number): SeedanceModel | undefined {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return undefined;
    const seconds = Math.ceil(durationSec);
    const fits = (model: SeedanceModel) => seconds <= SEEDANCE_MODELS[model].maxSec;
    return [this.model, this.longModel].find(fits);
  }

  private modelForRequest(request: VideoRequest): SeedanceModel | undefined {
    return this.modelFor(request.durationSec);
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

  private usdForTokens(tokens: number, model: SeedanceModel): number {
    return (tokens * SEEDANCE_MODELS[model].usdPerMillionTokens) / 1_000_000;
  }

  estimateCostPence(request: ProviderRequest): number {
    if (!isVideoRequest(request)) return 0;
    const model = this.modelForRequest(request);
    if (!model) return 0;
    const pixels = seedanceFramePixels(
      model,
      this.ratioFor(request, model),
      seedanceResolution(request),
    );
    const tokens = seedanceTokens(seedanceDuration(request.durationSec, model), pixels);
    return usdToPence(this.usdForTokens(tokens, model), this.options.usdToGbpRate);
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
      resolution: seedanceResolution(request),
      // The composer mutes generated clips (pipeline/edl.ts); our narration and music carry sound.
      generate_audio: false,
      watermark: false,
      execution_expires_after: EXECUTION_EXPIRES_AFTER_SEC,
      // Docs: a fixed per-end-user id (≤ 64 chars), hashed so no tenant id leaves Studio.
      safety_identifier: createHash('sha256').update(request.organisationId).digest('hex'),
    };
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    const body = this.buildBody(request);
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
    return {
      providerJobId: id,
      estimatedCostPence: this.estimateCostPence(request),
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
    // usage.completion_tokens is the billed amount ("the basis for billing reconciliation").
    const costPence =
      model && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
        ? usdToPence(this.usdForTokens(tokens, model), this.options.usdToGbpRate)
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
