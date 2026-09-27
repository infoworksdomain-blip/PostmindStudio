import { ProviderError } from '../../errors';
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
import { providerError } from './provider-errors';

// BACKLOG 2.6 — Runway (Layer 3 AI_CLIP). Contract from docs.dev.runwayml.com (read
// 2026-09-27; decoded from the API reference's OpenAPI spec):
//   base https://api.dev.runwayml.com, headers Authorization: Bearer, X-Runway-Version: 2024-11-06
//   POST /v1/text_to_video | /v1/image_to_video → { id }
//   GET  /v1/tasks/{id} → status PENDING|THROTTLED|RUNNING|SUCCEEDED|FAILED|CANCELLED
//   DELETE /v1/tasks/{id} → 204 (cancel or delete)
//
// SPEC DRIFT: Gen-4 Turbo is image-to-video only on the API, and "Gen-4 Alpha" no longer
// exists. Text-only shots use gen4.5 (Runway's current text-to-video model); shots with a
// source frame use gen4_turbo. Output URLs expire within 24–48h: Layer 3 workers copy them to S3.

export const PROVIDER_ID = 'runway';
export const BASE_URL = 'https://api.dev.runwayml.com';
export const API_VERSION = '2024-11-06';
export const TEXT_TO_VIDEO_MODEL = 'gen4.5';
export const IMAGE_TO_VIDEO_MODEL = 'gen4_turbo';
const USD_PER_CREDIT = 0.01;
const CREDITS_PER_SEC: Record<string, number> = { 'gen4.5': 12, gen4_turbo: 5 };
const MIN_DURATION_SEC = 2;
const MAX_DURATION_SEC = 10;
const TYPICAL_LATENCY_SEC = 120;
const TIMEOUT_MS = 30_000;

// Allowed `ratio` values per model/endpoint. 1:1 and 4:5 are image-to-video only.
const RATIO: Record<'text_to_video' | 'image_to_video', Partial<Record<AspectRatio, string>>> = {
  text_to_video: { '16:9': '1280:720', '9:16': '720:1280' },
  image_to_video: { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960', '4:5': '832:1104' },
};

type RunwayTask =
  | { id: string; status: 'PENDING' | 'THROTTLED' }
  | { id: string; status: 'RUNNING'; progress?: number }
  | { id: string; status: 'SUCCEEDED'; output: string[]; cost?: { credits: number } }
  | {
      id: string;
      status: 'FAILED';
      failure: string;
      failureCode?: string | null;
      cost?: { credits: number };
    }
  | { id: string; status: 'CANCELLED' };

export interface RunwayAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Map Runway's documented failureCode values (errors/task-failures) to Studio classes. */
export function classifyFailureCode(code: string | null | undefined): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  if (!code || code === 'INTERNAL' || code === 'INPUT_PREPROCESSING.INTERNAL') {
    return { class: 'provider_unavailable', retryable: true };
  }
  if (code === 'THIRD_PARTY.UNAVAILABLE') return { class: 'provider_unavailable', retryable: true };
  if (code.startsWith('SAFETY.') || code === 'INPUT_PREPROCESSING.SAFETY.TEXT') {
    return { class: 'content_policy', retryable: false };
  }
  if (code === 'ASSET.INVALID') return { class: 'invalid_request', retryable: false };
  // INTERNAL.BAD_OUTPUT.*: docs say retry only after changing the prompt.
  if (code.startsWith('INTERNAL.BAD_OUTPUT')) return { class: 'invalid_request', retryable: false };
  return { class: 'unknown', retryable: false };
}

function runwayErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body)
    return String((body as { error: unknown }).error);
  return typeof body === 'string' ? body : undefined;
}

export class RunwayAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_to_video', 'image_to_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: RunwayAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'X-Runway-Version': API_VERSION,
      'Content-Type': 'application/json',
    };
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<T>(
      `${BASE_URL}${path}`,
      { ...init, headers: this.headers() },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: runwayErrorMessage,
      },
    );
  }

  private creditsToPence(credits: number): number {
    return usdToPence(credits * USD_PER_CREDIT, this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') return 0;
    const model =
      request.capability === 'text_to_video' ? TEXT_TO_VIDEO_MODEL : IMAGE_TO_VIDEO_MODEL;
    return this.creditsToPence(Math.round(request.durationSec) * (CREDITS_PER_SEC[model] ?? 0));
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      throw this.invalid(`Runway adapter does not support ${request.capability}`);
    }
    const duration = Math.round(request.durationSec);
    if (duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) {
      throw this.invalid(
        `Runway clips must be ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s (got ${request.durationSec})`,
      );
    }
    const ratio = RATIO[request.capability][request.aspectRatio];
    if (!ratio)
      throw this.invalid(`${request.aspectRatio} is not supported for ${request.capability}`);

    const isText = request.capability === 'text_to_video';
    const model = isText ? TEXT_TO_VIDEO_MODEL : IMAGE_TO_VIDEO_MODEL;
    const body = isText
      ? { model, promptText: request.prompt, ratio, duration }
      : { model, promptText: request.prompt, promptImage: request.imageUrl, ratio, duration };

    const { body: created } = await this.request<{
      id: string;
      estimatedCost?: { credits: number };
    }>(`/v1/${request.capability}`, { method: 'POST', body: JSON.stringify(body) });
    const credits = created.estimatedCost?.credits ?? duration * (CREDITS_PER_SEC[model] ?? 0);
    return {
      providerJobId: created.id,
      estimatedCostPence: this.creditsToPence(credits),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    let task: RunwayTask;
    try {
      ({ body: task } = await this.request<RunwayTask>(
        `/v1/tasks/${encodeURIComponent(providerJobId)}`,
        { method: 'GET' },
      ));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) {
        return {
          state: 'failed',
          error: { class: 'result_expired', message: 'Runway task not found', retryable: true },
        };
      }
      throw err;
    }
    switch (task.status) {
      case 'PENDING':
      case 'THROTTLED':
      case 'RUNNING':
        return { state: 'running' };
      case 'SUCCEEDED': {
        const url = task.output[0];
        if (!url) {
          return {
            state: 'failed',
            error: {
              class: 'unknown',
              message: 'Runway task succeeded without output',
              retryable: true,
            },
          };
        }
        const credits = task.cost?.credits;
        return {
          state: 'succeeded',
          output: {
            url,
            metadata: {
              taskId: task.id,
              outputs: task.output,
              urlExpiresWithinHours: 24,
              ...(credits !== undefined && { credits, costPence: this.creditsToPence(credits) }),
            },
          },
        };
      }
      case 'FAILED': {
        const classified = classifyFailureCode(task.failureCode);
        return {
          state: 'failed',
          error: { ...classified, message: `${task.failureCode ?? 'FAILED'}: ${task.failure}` },
        };
      }
      case 'CANCELLED':
        return {
          state: 'failed',
          error: { class: 'unknown', message: 'Runway task was cancelled', retryable: false },
        };
    }
  }

  async cancel(providerJobId: string): Promise<void> {
    try {
      await this.request<unknown>(`/v1/tasks/${encodeURIComponent(providerJobId)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      // Docs: a 404 on an already-deleted task is safe to ignore.
      if (err instanceof ProviderError && err.details?.status === 404) return;
      throw err;
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const { body } = await this.request<{ creditBalance?: number }>('/v1/organization', {
        method: 'GET',
      });
      if (typeof body.creditBalance === 'number' && body.creditBalance <= 0) {
        return { healthy: false, reason: 'insufficient_credits: Runway credit balance is 0' };
      }
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }

  private invalid(message: string): ProviderError {
    return providerError(PROVIDER_ID, { errorClass: 'invalid_request', retryable: false }, message);
  }
}
