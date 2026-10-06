import { ConfigurationError, NotImplementedError, ProviderError } from '../../errors';
import {
  FAL_VIDEO_MODEL_KEYS,
  FAL_VIDEO_MODELS,
  falEndpointFor,
  isFalVideoModelKey,
  type FalMode,
  type FalVideoModelKey,
  type FalVideoPlan,
  type FalVideoRequest,
} from './fal-models';
import { httpJson } from './http';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderErrorClass,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';
import { classifyFalErrorType, classifyFalHttpError, falErrorMessage } from './fal-errors';
import { usdToPence } from './pricing';
import { providerError } from './provider-errors';

// BACKLOG 24.1 — fal.ai video provider (Layer 3 AI_CLIP). Contract from fal's docs (read
// 2026-10-06):
//   https://fal.ai/docs/model-apis/model-endpoints/queue (queue REST API)
//   https://fal.ai/docs/documentation/model-apis/errors.md (model + request error formats)
//   https://fal.ai/docs/documentation/model-apis/pricing.md (platform pricing endpoint)
//   base https://queue.fal.run, header Authorization: Key <FAL_KEY>
//   POST /{endpoint-id} <model input> → { request_id, status_url, response_url, cancel_url, … }
//   GET  /{endpoint-id}/requests/{id}/status → status IN_QUEUE | IN_PROGRESS | COMPLETED,
//        response_url; on COMPLETED a failed request carries `error` and `error_type`
//   GET  response_url (/{endpoint-id}/requests/{id}/response) → { video: { url, … } }
//   PUT  /{endpoint-id}/requests/{id}/cancel → 202 CANCELLATION_REQUESTED | 400 ALREADY_COMPLETED
//   GET  https://api.fal.ai/v1/models/pricing?endpoint_id=… — an authenticated read, used as the
//        health check (no generation, no charge).
// Model errors are 422 { detail: [{ loc, msg, type, … }] } (content_policy_violation = refused);
// request errors are { detail, error_type } with X-Fal-Error-Type (504 timeouts, 503 runner).
//
// fal's output URLs are public files on fal's CDN subject to the account's media expiration
// ("Download files you need to keep before they expire"); Layer 3 copies every clip into Studio's
// assets bucket as soon as the poll succeeds (generate-asset.ts recordAsset), like other clips.
//
// OPT-IN (24.1): the adapter is registered only when FAL_KEY is set AND STUDIO_FAL_VIDEO_MODELS
// names at least one model (falOptionsFromEnv); the router's `fal` slot is otherwise unconfigured.
// The first listed model that can serve a shot is used.

export const PROVIDER_ID = 'fal';
export const QUEUE_BASE_URL = 'https://queue.fal.run';
export const PLATFORM_BASE_URL = 'https://api.fal.ai/v1';
export const FAL_MODELS_ENV = 'STUDIO_FAL_VIDEO_MODELS';
export const FAL_KEY_ENV = 'FAL_KEY';
// Not documented by fal; a 5–10 s clip is expected within a few minutes.
const TYPICAL_LATENCY_SEC = 180;
const TIMEOUT_MS = 30_000;
const REQUEST_ID = /^[A-Za-z0-9-]{8,128}$/;
const JOB_ID = /^([a-z0-9.-]+):(t2v|i2v):([A-Za-z0-9-]{8,128})$/;

interface FalSubmitResponse {
  request_id?: string;
}

interface FalStatusResponse {
  status?: string;
  request_id?: string;
  response_url?: string;
  error?: string | null;
  error_type?: string | null;
}

interface FalVideoOutput {
  video?: { url?: string; content_type?: string; file_size?: number } | null;
}

export interface FalAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  /** Enabled models, in preference order (STUDIO_FAL_VIDEO_MODELS). At least one. */
  models: readonly FalVideoModelKey[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ParsedJobId {
  model: FalVideoModelKey;
  mode: FalMode;
  requestId: string;
}

/** Studio's job id for a fal request: `<model>:<t2v|i2v>:<request_id>`. */
export function falJobId(model: FalVideoModelKey, mode: FalMode, requestId: string): string {
  return `${model}:${mode}:${requestId}`;
}

export function parseFalJobId(providerJobId: string): ParsedJobId | undefined {
  const match = JOB_ID.exec(providerJobId);
  if (!match) return undefined;
  const [, model, mode, requestId] = match;
  if (!model || !isFalVideoModelKey(model) || !requestId) return undefined;
  return { model, mode: mode as FalMode, requestId };
}

export class FalAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_to_video', 'image_to_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: FalAdapterOptions) {
    if (options.models.length === 0) {
      throw new ConfigurationError('FalAdapter needs at least one enabled model');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get models(): readonly FalVideoModelKey[] {
    return this.options.models;
  }

  private request<T>(url: string, init: RequestInit) {
    return httpJson<T>(
      url,
      {
        ...init,
        headers: {
          Authorization: `Key ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: falErrorMessage,
        classifyError: classifyFalHttpError,
      },
    );
  }

  /** The first enabled model (in configured order) that can serve this request. */
  planFor(request: ProviderRequest): FalVideoPlan | undefined {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      return undefined;
    }
    for (const key of this.options.models) {
      const plan = FAL_VIDEO_MODELS[key].plan(request as FalVideoRequest);
      if (plan) return plan;
    }
    return undefined;
  }

  supportsRequest(request: ProviderRequest): boolean {
    return this.planFor(request) !== undefined;
  }

  private planPence(plan: FalVideoPlan): number {
    return usdToPence(plan.billedSec * plan.usdPerSec, this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    const plan = this.planFor(request);
    return plan ? this.planPence(plan) : 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      throw this.invalid(`fal adapter does not support ${request.capability}`);
    }
    if (request.capability === 'image_to_video') assertHttpsUrl(request.imageUrl, this);
    const plan = this.planFor(request);
    if (!plan) {
      throw this.invalid(
        `No enabled fal model (${this.options.models.join(', ')}) can render a ${request.durationSec}s ${request.aspectRatio} clip`,
      );
    }
    const { body } = await this.request<FalSubmitResponse>(`${QUEUE_BASE_URL}/${plan.endpointId}`, {
      method: 'POST',
      body: JSON.stringify(plan.input),
    });
    const requestId = body?.request_id;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'fal queue submit returned no request_id',
      );
    }
    return {
      providerJobId: falJobId(plan.model, plan.mode, requestId),
      estimatedCostPence: this.planPence(plan),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  private requestBase(job: ParsedJobId): string {
    return `${QUEUE_BASE_URL}/${falEndpointFor(job.model, job.mode)}/requests/${job.requestId}`;
  }

  private async status(job: ParsedJobId): Promise<FalStatusResponse | 'not_found'> {
    try {
      const { body } = await this.request<FalStatusResponse>(`${this.requestBase(job)}/status`, {
        method: 'GET',
      });
      return body ?? {};
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) return 'not_found';
      throw err;
    }
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    const job = parseFalJobId(providerJobId);
    if (!job) {
      return failed('invalid_request', `Not a fal job id: ${providerJobId}`, false);
    }
    const status = await this.status(job);
    if (status === 'not_found') return failed('result_expired', 'fal request not found', true);
    switch (status.status) {
      case 'IN_QUEUE':
      case 'IN_PROGRESS':
        return { state: 'running' };
      case 'COMPLETED':
        if (status.error || status.error_type) {
          const classified = classifyFalErrorType(status.error_type, status.error);
          return failed(
            classified.class,
            `${status.error_type ?? 'error'}: ${status.error ?? 'fal request failed'}`,
            classified.retryable,
          );
        }
        return this.result(job, status.response_url);
      default:
        return failed(
          'unknown',
          `fal returned an unrecognized status: ${String(status.status)}`,
          true,
        );
    }
  }

  /** Fetch the finished output (response_url from the status body when it is fal's queue). */
  private async result(job: ParsedJobId, responseUrl: string | undefined) {
    const url =
      typeof responseUrl === 'string' && responseUrl.startsWith(`${QUEUE_BASE_URL}/`)
        ? responseUrl
        : `${this.requestBase(job)}/response`;
    const { body } = await this.request<FalVideoOutput>(url, { method: 'GET' });
    const videoUrl = body?.video?.url;
    if (typeof videoUrl !== 'string' || !videoUrl.startsWith('https://')) {
      return failed('unknown', 'fal request completed without a video URL', true);
    }
    const result: ProviderPollResult = {
      state: 'succeeded',
      output: {
        url: videoUrl,
        metadata: {
          requestId: job.requestId,
          model: job.model,
          endpointId: falEndpointFor(job.model, job.mode),
          contentType: body?.video?.content_type,
          fileSize: body?.video?.file_size,
          // fal CDN files follow the account's media expiration; Layer 3 copies them at once.
          hostedBy: 'fal-cdn',
        },
      },
    };
    return result;
  }

  /**
   * PUT cancel stops a request still IN_QUEUE (202 CANCELLATION_REQUESTED). fal does not say a
   * request already IN_PROGRESS stops being billed, so that case is NotImplementedError (the job
   * keeps its cost reservation, as for Seedance, Luma and Veo). A finished or unknown request
   * needs nothing.
   */
  async cancel(providerJobId: string): Promise<void> {
    const job = parseFalJobId(providerJobId);
    if (!job) throw this.invalid('Not a fal job id');
    const status = await this.status(job);
    if (status === 'not_found' || status.status === 'COMPLETED') return;
    if (status.status !== 'IN_QUEUE') {
      throw new NotImplementedError(
        `fal cannot promise to stop a running request; ${providerJobId} runs to completion`,
      );
    }
    try {
      await this.request<unknown>(`${this.requestBase(job)}/cancel`, { method: 'PUT' });
    } catch (err) {
      // 400 ALREADY_COMPLETED / 404 NOT_FOUND: nothing left to cancel.
      const code = err instanceof ProviderError ? err.details?.status : undefined;
      if (code === 400 || code === 404) return;
      throw err;
    }
  }

  /** The platform pricing read for the first enabled endpoint: authenticated, unbilled. */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    const first = this.options.models[0] as FalVideoModelKey;
    const endpoint = encodeURIComponent(falEndpointFor(first, 't2v'));
    try {
      await this.request<unknown>(`${PLATFORM_BASE_URL}/models/pricing?endpoint_id=${endpoint}`, {
        method: 'GET',
      });
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }

  invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}

function failed(cls: ProviderErrorClass, message: string, retryable: boolean): ProviderPollResult {
  return { state: 'failed', error: { class: cls, message, retryable } };
}

function assertHttpsUrl(value: string, adapter: FalAdapter): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw adapter.invalid('fal source frame URL is not a URL');
  }
  if (parsed.protocol !== 'https:') throw adapter.invalid('fal source frames must be https URLs');
}

type Env = Record<string, string | undefined>;

/**
 * STUDIO_FAL_VIDEO_MODELS: comma-separated model keys in preference order; empty = fal is off.
 * An unknown or repeated key is a ConfigurationError (a typo must not silently disable a model).
 */
export function parseFalVideoModels(raw: string | undefined): FalVideoModelKey[] {
  const keys = (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  const out: FalVideoModelKey[] = [];
  for (const key of keys) {
    if (!isFalVideoModelKey(key)) {
      throw new ConfigurationError(
        `${FAL_MODELS_ENV}: unknown fal model "${key}" (one of ${FAL_VIDEO_MODEL_KEYS.join(', ')})`,
      );
    }
    if (out.includes(key)) {
      throw new ConfigurationError(`${FAL_MODELS_ENV}: "${key}" is listed twice`);
    }
    out.push(key);
  }
  return out;
}

/**
 * The fal adapter's settings from env, or undefined when fal is off (no models listed). Models
 * listed without FAL_KEY is a ConfigurationError, so an opt-in never silently does nothing.
 */
export function falOptionsFromEnv(
  env: Env,
): { apiKey: string; models: FalVideoModelKey[] } | undefined {
  const models = parseFalVideoModels(env[FAL_MODELS_ENV]);
  if (models.length === 0) return undefined;
  const apiKey = env[FAL_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new ConfigurationError(`${FAL_MODELS_ENV} is set but ${FAL_KEY_ENV} is empty`);
  }
  return { apiKey, models };
}

/**
 * 24.1: one fal model on its own, for scripts and bake-offs (bypasses STUDIO_FAL_VIDEO_MODELS and
 * the router). Needs FAL_KEY in `env`.
 */
export function createFalModelAdapter(
  model: FalVideoModelKey,
  options: { usdToGbpRate: number; env?: Env; fetchImpl?: typeof fetch },
): FalAdapter {
  const apiKey = (options.env ?? process.env)[FAL_KEY_ENV]?.trim();
  if (!apiKey) throw new ConfigurationError(`${FAL_KEY_ENV} is required to call fal`);
  return new FalAdapter({
    apiKey,
    usdToGbpRate: options.usdToGbpRate,
    models: [model],
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
  });
}
