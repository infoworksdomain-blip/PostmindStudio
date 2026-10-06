import { createHmac } from 'node:crypto';
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

// BACKLOG 20.24 — Kling 3.0 (Kling AI Pte. Ltd., a Kuaishou company) as an AI_CLIP provider
// (operator decision 2026-10-02). Contract read 2026-10-02 from the official Kling AI API docs:
//   https://kling.ai/document-api/api/get-started/authentication   (domain + API key)
//   https://kling.ai/document-api/api/get-started/error-codes      (HTTP + service codes)
//   https://kling.ai/document-api/api/get-started/concurrency-rules (1303 over the pack limit)
//   https://kling.ai/document-api/api/video/3-0-omni/text-to-video  (create + query task)
//   https://kling.ai/document-api/api/video/3-0-omni/image-to-video (first_frame contents)
//   https://kling.ai/document-api/api/assets/account-usage          (GET /account/costs, free)
//   https://kling.ai/dev/pricing                                    (units per second, USD)
//   https://kling.ai/document-api/guides/protocols/paid-service     (Kling AI Pte. Ltd. terms,
//                                                                    effective 2026-04-21)
// (app.klingai.com/global/dev/document-api/… now 301-redirects to kling.ai/document-api/….)
//
//   POST https://api-singapore.klingai.com/text-to-video/kling-3.0
//        { prompt, settings: { multi_shot, audio, resolution, aspect_ratio, duration },
//          options: { watermark_info: { enabled } } }
//   POST https://api-singapore.klingai.com/image-to-video/kling-3.0
//        { contents: [{ type: "prompt", text }, { type: "first_frame", url }], settings: { … } }
//        → { code: 0, message, request_id, data: { id, status, … } }
//   GET  https://api-singapore.klingai.com/tasks?task_ids={id}
//        → { code: 0, data: [{ id, status, message, outputs: [{ type: "video", url, duration }],
//              billing: [{ charge_type, amount, currency, … }] }] }
//   Header on every call: Authorization: Bearer <token>. Two documented credentials:
//     - API Key (current): "API Key authentication must be used to call Kling AI API"; the key
//       itself is the token (KLING_API_KEY). Preferred.
//     - AccessKey + SecretKey (legacy): a JWT per RFC 7519, header { alg: HS256, typ: JWT },
//       payload { iss: <AccessKey>, exp: now + 1800, nbf: now - 5 }, signed with the SecretKey
//       (KLING_ACCESS_KEY + KLING_SECRET_KEY; signKlingJwt below). The docs label this pair
//       "only applicable to legacy version design standards"; whether the kling-3.0 endpoints
//       accept it is UNCONFIRMED, so the API key wins when both are set.
//
// Facts that shape this adapter:
//   - Task status: submitted | processing | succeeded | failed (failed carries `message`, e.g.
//     "triggering the content risk control of the platform").
//   - settings.duration: integer 3–15 s; aspect_ratio 16:9 | 9:16 | 1:1 (text-to-video only;
//     image-to-video follows the frame); resolution 720p (default) | 1080p | 4k.
//   - settings.audio "off" | "native" (default off). We always send "off": the composer mutes
//     generated clips and silent is cheaper (720p 0.6 units/s vs 0.9 with audio).
//   - settings.multi_shot defaults to TRUE; we send false, one shot per clip.
//   - The current API has no std/pro `mode`, `negative_prompt` or `cfg_scale`: resolution is
//     the quality knob (KLING_RESOLUTION), negatives go in the prompt text.
//   - Output URLs are "hotlink protection format" and "will be cleared after 30 days": Layer 3
//     copies the clip into our bucket as soon as the task succeeds. No credential is documented
//     for the download, so there is no fetchOutput (UNCONFIRMED until the first live run).
//   - No cancel endpoint is documented (cancel() says so, like Veo and Luma).
//   - Concurrency is per account + model + resource pack (20 for the standard video packs);
//     over it, 429 code 1303. No QPS limit is imposed on the API.

export const PROVIDER_ID = 'kling';
export const DEFAULT_BASE_URL = 'https://api-singapore.klingai.com';

/**
 * Model path segment → USD per second of SILENT video (pricing page, "Kling 3.0 … No Native
 * Audio": 720p 0.6 units = $0.084/s, 1080p 0.8 units = $0.112/s; 1 unit = $0.14 list price).
 */
export const KLING_MODELS = {
  'kling-3.0': { usdPerSec: { '720p': 0.084, '1080p': 0.112 } },
} as const;
export type KlingModel = keyof typeof KLING_MODELS;
export const DEFAULT_KLING_MODEL: KlingModel = 'kling-3.0';

/**
 * BACKLOG 21.4 — UGC actor clips (`actor_video`) WITH native audio, opt-in (KLING_UGC_ACTOR=1):
 * pricing page (https://kling.ai/document-api/pricing/base/video, read 2026-10-04), "Kling 3.0 …
 * Native Audio" without voice control: 720p 0.9 units = $0.126/s, 1080p 1.2 units = $0.168/s.
 * settings.audio "native" is documented on the text-to-video page; how to write dialogue and how
 * well lips follow it are NOT documented, so this is the fallback behind Veo and stays off until
 * the operator has judged a few clips (plans/phase-21-ugc.md). The product image is not sent:
 * text-to-video has no reference input and a first frame would open the clip on the photo.
 */
export const KLING_NATIVE_AUDIO_USD_PER_SEC: Readonly<Record<'720p' | '1080p', number>> = {
  '720p': 0.126,
  '1080p': 0.168,
};
export const KLING_UGC_ACTOR_ENV = 'KLING_UGC_ACTOR';

/** 4k (3.0 units/s = $0.42/s) is documented but deliberately not offered. */
export const KLING_RESOLUTIONS = ['720p', '1080p'] as const;
export type KlingResolution = (typeof KLING_RESOLUTIONS)[number];
export const DEFAULT_KLING_RESOLUTION: KlingResolution = '720p';

/** List price of one video unit (pricing page); resource packs sell at $0.14 or $0.126. */
export const USD_PER_VIDEO_UNIT = 0.14;

export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 15;
const MIN_SHOT_SEC = 1;
const MAX_PROMPT_CHARS = 3072;
// Latency is not documented: an assumption (UNCONFIRMED), used for router deadlines only.
const TYPICAL_LATENCY_SEC = 180;
const TIMEOUT_MS = 30_000;
const HEALTH_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** Text-to-video renders 16:9, 9:16 and 1:1; 4:5 uses portrait and the composer crops. */
export const KLING_RATIO: Record<AspectRatio, '16:9' | '9:16' | '1:1'> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '1:1',
  '4:5': '9:16',
};

export const KLING_KEY_ENV = 'KLING_API_KEY';
export const KLING_ACCESS_KEY_ENV = 'KLING_ACCESS_KEY';
export const KLING_SECRET_KEY_ENV = 'KLING_SECRET_KEY';
/** Legacy JWT lifetime and clock-skew allowance from the authentication page's sample. */
export const KLING_JWT_TTL_SEC = 1800;
export const KLING_JWT_NBF_SKEW_SEC = 5;

export type KlingCredentials =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'access_key'; accessKey: string; secretKey: string };

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** The legacy AccessKey/SecretKey token: HS256 JWT { iss, exp, nbf } (authentication page). */
export function signKlingJwt(accessKey: string, secretKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: accessKey,
      exp: now + KLING_JWT_TTL_SEC,
      nbf: now - KLING_JWT_NBF_SKEW_SEC,
    }),
  );
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(signature)}`;
}

/**
 * The credential to use from env-style values: KLING_API_KEY first, else the complete legacy
 * pair. Half a pair is a configuration error (it can never authenticate). Undefined = no Kling.
 */
export function klingCredentialsFrom(values: {
  apiKey?: string;
  accessKey?: string;
  secretKey?: string;
}): KlingCredentials | undefined {
  const apiKey = values.apiKey?.trim();
  if (apiKey) return { kind: 'api_key', apiKey };
  const accessKey = values.accessKey?.trim();
  const secretKey = values.secretKey?.trim();
  if (accessKey && secretKey) return { kind: 'access_key', accessKey, secretKey };
  if (accessKey || secretKey) {
    throw new ConfigurationError(
      `${KLING_ACCESS_KEY_ENV} and ${KLING_SECRET_KEY_ENV} must be set together (or use ${KLING_KEY_ENV})`,
    );
  }
  return undefined;
}

export const KLING_MODEL_ENV = 'KLING_MODEL';
export const KLING_RESOLUTION_ENV = 'KLING_RESOLUTION';
export const KLING_BASE_URL_ENV = 'KLING_BASE_URL';

export function isKlingModel(value: string): value is KlingModel {
  return Object.hasOwn(KLING_MODELS, value);
}

export function isKlingResolution(value: string): value is KlingResolution {
  return (KLING_RESOLUTIONS as readonly string[]).includes(value);
}

/** An https origin with no path, query or credentials (KLING_BASE_URL). */
export function isKlingBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Shots render at the next whole second up, at least 3 s; the composer trims the rest. */
export function klingDuration(durationSec: number): number {
  return Math.min(MAX_CLIP_SEC, Math.max(MIN_CLIP_SEC, Math.ceil(durationSec)));
}

/**
 * KLING_MODEL, KLING_RESOLUTION and KLING_BASE_URL (all optional). An unknown value is a
 * configuration error, never a silent default: a model without a price row cannot be
 * budget-checked, and the API key must never be sent to an arbitrary host.
 */
export function klingOptionsFromEnv(
  env: Record<string, string | undefined>,
): Pick<KlingAdapterOptions, 'model' | 'resolution' | 'baseUrl' | 'actorVideo'> {
  const actor = env[KLING_UGC_ACTOR_ENV]?.trim() ?? '';
  if (actor && actor !== '0' && actor !== '1') {
    throw new ConfigurationError(`${KLING_UGC_ACTOR_ENV} must be 1, 0 or empty`);
  }
  const model = env[KLING_MODEL_ENV]?.trim() ?? '';
  const resolution = env[KLING_RESOLUTION_ENV]?.trim() ?? '';
  const baseUrl = env[KLING_BASE_URL_ENV]?.trim() ?? '';
  if (model && !isKlingModel(model)) {
    throw new ConfigurationError(
      `${KLING_MODEL_ENV} must be one of ${Object.keys(KLING_MODELS).join(', ')} (or empty)`,
    );
  }
  if (resolution && !isKlingResolution(resolution)) {
    throw new ConfigurationError(
      `${KLING_RESOLUTION_ENV} must be ${KLING_RESOLUTIONS.join(' or ')} (or empty)`,
    );
  }
  if (baseUrl && !isKlingBaseUrl(baseUrl)) {
    throw new ConfigurationError(`${KLING_BASE_URL_ENV} must be an https origin (or empty)`);
  }
  return {
    ...(model && { model: model as KlingModel }),
    ...(resolution && { resolution: resolution as KlingResolution }),
    ...(baseUrl && { baseUrl: baseUrl.replace(/\/$/, '') }),
    ...(actor === '1' && { actorVideo: true }),
  };
}

export interface KlingAdapterOptions {
  credentials: KlingCredentials;
  usdToGbpRate: number;
  model?: KlingModel;
  resolution?: KlingResolution;
  baseUrl?: string;
  /** 21.4: also make UGC actor clips with native audio (KLING_UGC_ACTOR=1). */
  actorVideo?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface KlingEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface KlingTask {
  id?: string;
  status?: string;
  message?: string;
  outputs?: Array<{ type?: string; url?: string; duration?: string }>;
  billing?: Array<{ charge_type?: string; amount?: string; currency?: string }>;
}

// --- error classification -------------------------------------------------------------------
// Service codes from the Error Codes page. Failed-task messages are free text (only the
// content-risk example is documented), so they are matched loosely (UNCONFIRMED wording).

const CONTENT_RISK_TEXT = /risk|sensitive|security polic|content polic|prohibit|violat|illegal/i;

const SERVICE_CODES: Readonly<Record<number, ErrorClassification>> = {
  1000: { errorClass: 'auth', retryable: false }, // authentication failed
  1001: { errorClass: 'auth', retryable: false }, // Authorization empty
  1002: { errorClass: 'auth', retryable: false }, // Authorization invalid
  1003: { errorClass: 'auth', retryable: false }, // not yet valid
  1004: { errorClass: 'auth', retryable: false }, // expired
  1100: { errorClass: 'account_limit', retryable: false }, // abnormal account status
  1101: { errorClass: 'insufficient_credits', retryable: false }, // arrears (postpaid)
  1102: { errorClass: 'insufficient_credits', retryable: false }, // resource pack exhausted/expired
  1103: { errorClass: 'auth', retryable: false }, // no access to this API / model
  1200: { errorClass: 'invalid_request', retryable: false },
  1201: { errorClass: 'invalid_request', retryable: false },
  1202: { errorClass: 'invalid_request', retryable: false }, // wrong method
  1203: { errorClass: 'invalid_request', retryable: false }, // resource (model) does not exist
  1300: { errorClass: 'content_policy', retryable: false }, // blocked by platform policy
  1301: { errorClass: 'content_policy', retryable: false }, // content security policy
  1302: { errorClass: 'rate_limited', retryable: true }, // too many requests
  1303: { errorClass: 'rate_limited', retryable: true }, // concurrency over the pack limit
  1304: { errorClass: 'auth', retryable: false }, // IP whitelist policy: account configuration
  5000: { errorClass: 'provider_unavailable', retryable: true },
  5001: { errorClass: 'provider_unavailable', retryable: true }, // maintenance
  5002: { errorClass: 'timeout', retryable: true }, // internal timeout (backlog)
};

/**
 * 20.19 (shared rule, provider-errors.ts): out-of-credit wording on what would otherwise be an
 * input error or an unknown failure is an ACCOUNT problem (same as veo.ts withOutOfCredit).
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

function envelopeOf(body: unknown): KlingEnvelope<unknown> | undefined {
  return body && typeof body === 'object' ? (body as KlingEnvelope<unknown>) : undefined;
}

/** Classify a Kling service code; unknown codes fall back to the HTTP status. */
export function classifyKlingError(
  status: number,
  code: number | undefined,
  message: string,
): ErrorClassification {
  const known = code === undefined ? undefined : SERVICE_CODES[code];
  return withOutOfCredit(known ?? classifyHttpStatus(status), message);
}

export function classifyKlingHttpError(status: number, body: unknown): ErrorClassification {
  const envelope = envelopeOf(body);
  const message = typeof envelope?.message === 'string' ? envelope.message : '';
  return classifyKlingError(status, envelope?.code, message);
}

/** A task that finished with status "failed". */
export function classifyTaskFailure(message: string): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  if (isOutOfCreditMessage(message)) return { class: 'insufficient_credits', retryable: false };
  if (CONTENT_RISK_TEXT.test(message)) return { class: 'content_policy', retryable: false };
  return { class: 'unknown', retryable: true };
}

function klingErrorMessage(body: unknown): string | undefined {
  const envelope = envelopeOf(body);
  if (envelope && (envelope.code !== undefined || envelope.message !== undefined)) {
    return `${envelope.code ?? 'error'}: ${envelope.message ?? ''}`.trim();
  }
  return typeof body === 'string' ? body : undefined;
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class KlingAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;
  readonly model: KlingModel;
  readonly resolution: KlingResolution;
  readonly baseUrl: string;
  readonly authKind: KlingCredentials['kind'];

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: KlingAdapterOptions) {
    this.model = options.model ?? DEFAULT_KLING_MODEL;
    this.resolution = options.resolution ?? DEFAULT_KLING_RESOLUTION;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.authKind = options.credentials.kind;
    this.capabilities = options.actorVideo
      ? ['text_to_video', 'image_to_video', 'actor_video']
      : ['text_to_video', 'image_to_video'];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Calls the API; a 200 whose envelope `code` is not 0 is an error too. */
  private async request<T>(path: string, init: RequestInit): Promise<T | undefined> {
    const { status, body } = await httpJson<KlingEnvelope<T>>(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.bearerToken()}`,
          'Content-Type': 'application/json',
        },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: klingErrorMessage,
        classifyError: classifyKlingHttpError,
      },
    );
    if (body && typeof body === 'object' && typeof body.code === 'number' && body.code !== 0) {
      const message = klingErrorMessage(body) ?? `code ${body.code}`;
      throw providerError(PROVIDER_ID, classifyKlingHttpError(status, body), message, {
        status,
        code: body.code,
      });
    }
    return body?.data;
  }

  /** The API key as is, or a fresh legacy JWT (30 min) for each call. */
  private bearerToken(): string {
    const c = this.options.credentials;
    return c.kind === 'api_key' ? c.apiKey : signKlingJwt(c.accessKey, c.secretKey, this.now());
  }

  private usdPerSec(): number {
    return KLING_MODELS[this.model].usdPerSec[this.resolution];
  }

  /** Router hint: Kling 3.0 renders 3–15 s; shorter shots render 3 s and are trimmed. */
  supportsRequest(request: ProviderRequest): boolean {
    if (request.capability === 'actor_video') {
      return (
        Boolean(this.options.actorVideo) &&
        // 22.1: Kling's actor path is native-audio dialogue only; silent reaction clips go to Veo.
        !request.silent &&
        request.spokenLine.trim().length > 0 &&
        request.durationSec >= MIN_SHOT_SEC &&
        request.durationSec <= MAX_CLIP_SEC
      );
    }
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      return false;
    }
    return request.durationSec >= MIN_SHOT_SEC && request.durationSec <= MAX_CLIP_SEC;
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability === 'actor_video') {
      return usdToPence(
        klingDuration(request.durationSec) * KLING_NATIVE_AUDIO_USD_PER_SEC[this.resolution],
        this.options.usdToGbpRate,
      );
    }
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') return 0;
    return usdToPence(
      klingDuration(request.durationSec) * this.usdPerSec(),
      this.options.usdToGbpRate,
    );
  }

  /** The create-task path and body for a shot (exported shape for tests and reviews). */
  buildRequest(request: ProviderRequest): { path: string; body: Record<string, unknown> } {
    if (request.capability === 'actor_video') return this.buildActorRequest(request);
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      throw this.invalid(`Kling adapter does not support ${request.capability}`);
    }
    if (!this.supportsRequest(request)) {
      throw this.invalid(
        `Kling clips cover ${MIN_SHOT_SEC}–${MAX_CLIP_SEC}s shots (got ${request.durationSec})`,
      );
    }
    const prompt = request.prompt.trim();
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Kling prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    const settings = {
      multi_shot: false,
      audio: 'off',
      resolution: this.resolution,
      duration: klingDuration(request.durationSec),
    };
    const options = { watermark_info: { enabled: false } };
    if (request.capability === 'text_to_video') {
      return {
        path: `/text-to-video/${this.model}`,
        body: {
          prompt,
          settings: { ...settings, aspect_ratio: KLING_RATIO[request.aspectRatio] },
          options,
        },
      };
    }
    return {
      path: `/image-to-video/${this.model}`,
      body: {
        contents: [
          { type: 'prompt', text: prompt },
          { type: 'first_frame', url: this.frameUrl(request.imageUrl) },
        ],
        settings,
        options,
      },
    };
  }

  /**
   * 21.4: a UGC actor clip as text-to-video with settings.audio "native". The line is quoted in
   * the prompt (Kling documents no dialogue syntax; quoting is the common convention).
   *
   * 21.4a: with the project's actor portrait and a portrait format (9:16 / 4:5), image-to-video
   * with the portrait as `first_frame` and audio "native", so every Kling clip starts on the same
   * person. Read 2026-10-04 from https://kling.ai/document-api/api/video/3-0-omni/image-to-video:
   * contents types "prompt, first frame, last frame, Element"; first_frame `url` "via URL or
   * Base64", .jpg/.jpeg/.png, ≤ 50MB, ≥ 300px, aspect ratio 1:2.5 to 2.5:1; settings.audio
   * "native" | "off" on the same page (its example combines first_frame with audio "native").
   * The output follows the frame (no aspect_ratio), so a landscape or square video keeps
   * text-to-video (a 2:3 portrait would be cropped hard). Kling's documented subject reference is
   * an "Element" (element_id from the Element Management API): not built (a second paid object per
   * project); noted in plans/phase-21-ugc.md.
   */
  private buildActorRequest(request: ActorVideoRequest): {
    path: string;
    body: Record<string, unknown>;
  } {
    if (!this.supportsRequest(request)) {
      throw this.invalid('Kling actor clips are off (KLING_UGC_ACTOR) or the shot is invalid');
    }
    const line = request.spokenLine.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
    const prompt = `${request.prompt.trim()}\nThe person speaks directly to the camera and says: "${line}"`;
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Kling prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    if (request.actorImageUrl && KLING_RATIO[request.aspectRatio] === '9:16') {
      return {
        path: `/image-to-video/${this.model}`,
        body: {
          contents: [
            { type: 'prompt', text: prompt },
            { type: 'first_frame', url: this.frameUrl(request.actorImageUrl) },
          ],
          settings: {
            multi_shot: false,
            audio: 'native',
            resolution: this.resolution,
            duration: klingDuration(request.durationSec),
          },
          options: { watermark_info: { enabled: false } },
        },
      };
    }
    return {
      path: `/text-to-video/${this.model}`,
      body: {
        prompt,
        settings: {
          multi_shot: false,
          audio: 'native',
          resolution: this.resolution,
          duration: klingDuration(request.durationSec),
          aspect_ratio: KLING_RATIO[request.aspectRatio],
        },
        options: { watermark_info: { enabled: false } },
      },
    };
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    const { path, body } = this.buildRequest(request);
    const task = await this.request<KlingTask>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!task || typeof task.id !== 'string' || !TASK_ID.test(task.id)) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Kling did not return a task id',
      );
    }
    return {
      providerJobId: task.id,
      estimatedCostPence: this.estimateCostPence(request),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    if (!TASK_ID.test(providerJobId)) {
      return {
        state: 'failed',
        error: { class: 'invalid_request', message: 'Not a Kling task id', retryable: false },
      };
    }
    const tasks = await this.request<KlingTask[]>(
      `/tasks?task_ids=${encodeURIComponent(providerJobId)}`,
      { method: 'GET' },
    );
    const task = Array.isArray(tasks) ? tasks.find((t) => t.id === providerJobId) : undefined;
    if (!task) {
      return {
        state: 'failed',
        error: { class: 'result_expired', message: 'Kling task not found', retryable: true },
      };
    }
    if (task.status === 'submitted' || task.status === 'processing') return { state: 'running' };
    if (task.status === 'failed') {
      const message = task.message ?? 'Kling generation failed';
      return { state: 'failed', error: { ...classifyTaskFailure(message), message } };
    }
    if (task.status !== 'succeeded') {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: `Kling task has an unknown status: ${String(task.status)}`,
          retryable: true,
        },
      };
    }
    const video = task.outputs?.find((o) => o.type === 'video' && typeof o.url === 'string');
    if (!video?.url) {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: 'Kling task finished without a video',
          retryable: true,
        },
      };
    }
    const costPence = this.billedPence(task.billing);
    return {
      state: 'succeeded',
      output: {
        url: video.url,
        metadata: {
          taskId: providerJobId,
          model: this.model,
          resolution: this.resolution,
          audio: 'off',
          ...(video.duration && { durationSec: Number(video.duration) }),
          // Docs: results "will be cleared after 30 days"; Layer 3 copies the clip at once.
          urlExpiresWithinHours: 30 * 24,
          ...(costPence !== undefined && { costPence }),
        },
      },
    };
  }

  /**
   * The task's own billing, when it is in USD ("cash") or resource-pack units (priced at the
   * $0.14 list price, so packs bought at $0.126 are slightly over-counted). CNY balances and
   * anything unparseable leave the submit-time estimate in place (tracked.ts).
   */
  private billedPence(billing: KlingTask['billing']): number | undefined {
    if (!Array.isArray(billing) || billing.length === 0) return undefined;
    let usd = 0;
    for (const line of billing) {
      const amount = Number(line.amount);
      if (!Number.isFinite(amount) || amount < 0) return undefined;
      if (line.charge_type === 'unit') usd += amount * USD_PER_VIDEO_UNIT;
      else if (line.charge_type === 'cash' && line.currency === 'USD') usd += amount;
      else return undefined;
    }
    return usdToPence(usd, this.options.usdToGbpRate);
  }

  /** No cancel endpoint is documented for Kling tasks; the job keeps its cost reservation. */
  async cancel(providerJobId: string): Promise<void> {
    throw new NotImplementedError(
      `Kling documents no cancel for tasks; ${providerJobId} runs to completion`,
    );
  }

  /** GET /account/costs: free to call (QPS ≤ 1) and proves the key works. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    const end = this.now();
    const query = `start_time=${end - HEALTH_WINDOW_MS}&end_time=${end}`;
    try {
      await this.request<unknown>(`/account/costs?${query}`, { method: 'GET' });
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }

  /** Image-to-video takes the first frame by URL (or base64); we pass our https URL. */
  private frameUrl(imageUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw this.invalid('Kling source frame URL is not a URL');
    }
    if (parsed.protocol !== 'https:') throw this.invalid('Kling source frames must be https URLs');
    return parsed.href;
  }

  private invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
