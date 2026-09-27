import { NotImplementedError, ProviderError } from '../../errors';
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

// BACKLOG 13.32 — Luma (Layer 3 AI_CLIP; spec 6.2, 6.4). Contract from the Luma Agents API docs
// (read 2026-09-27):
//   https://docs.agents.lumalabs.ai/guides/videos/generation/
//   https://docs.agents.lumalabs.ai/api/resources/generations/methods/create/
//   https://docs.agents.lumalabs.ai/api/resources/generations/methods/get/
//   https://docs.agents.lumalabs.ai/guides/error-handling/
//   https://docs.agents.lumalabs.ai/guides/pricing/
//   https://docs.agents.lumalabs.ai/guides/faq/ (no cancel endpoint; refunds on failure)
//   base https://agents.lumalabs.ai/v1, header Authorization: Bearer <key>
//   POST /generations { model: "ray-3.2", type: "video", prompt, aspect_ratio,
//                       video: { resolution, duration, keyframes?, keyframe_indexes? } } → 201
//   GET  /generations/{id} → state queued|processing|completed|failed, output[].url (1h expiry),
//                            failure_code, failure_reason
//   GET  /files?limit=1 — cheapest documented authenticated read, used as the health check.
//
// SPEC DRIFT: the spec names "Ray 2, Dream Machine" on api.lumalabs.ai/dream-machine/v1. Luma
// is retiring Ray 2 / Ray 3 on that legacy API ("Migrate legacy Ray models",
// https://docs.agents.lumalabs.ai/guides/videos/migration/); new integrations must use ray-3.2
// on the Agents API. Ray 3.2 renders only 5s or 10s clips, so a shot is rounded UP to the next
// supported length and the composer trims it to the shot's duration (edl.ts `length`).
// Image-to-video uses a single keyframe at index 0 (documented as equivalent to start_frame, and
// unlike start_frame it is allowed with 10s).

export const PROVIDER_ID = 'luma';
export const BASE_URL = 'https://agents.lumalabs.ai/v1';
export const MODEL = 'ray-3.2';
export const RESOLUTION = '720p';
// Pricing page, "ray-3.2 — per-video pricing", Video generation, Standard dynamic range, 720p.
const USD_PER_CLIP: Record<LumaDuration, number> = { '5s': 0.3, '10s': 0.9 };
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 10;
const MAX_PROMPT_CHARS = 6000;
// Docs: "a 5s/720p generation typically completes in well under two minutes".
const TYPICAL_LATENCY_SEC = 120;
const TIMEOUT_MS = 30_000;

type LumaDuration = '5s' | '10s';

// Ray 3.2 accepts 9:16, 3:4, 1:1, 4:3, 16:9, 21:9. 4:5 is not offered, so 4:5 shots use the
// nearest portrait ratio (3:4) and the composer's fit "cover" crops the small difference.
const RATIO: Record<AspectRatio, string> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '1:1',
  '4:5': '3:4',
};

interface LumaGeneration {
  id: string;
  state: 'queued' | 'processing' | 'completed' | 'failed';
  model?: string;
  type?: string;
  output?: Array<{ type: string; url: string }> | null;
  failure_code?: string | null;
  failure_reason?: string | null;
}

export interface LumaAdapterOptions {
  apiKey: string;
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Map Luma's documented async failure_code values (guides/error-handling) to Studio classes. */
export function classifyFailureCode(code: string | null | undefined): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  switch (code) {
    case 'content_moderated':
      return { class: 'content_policy', retryable: false };
    case 'generation_failed':
    case 'output_not_found':
      return { class: 'provider_unavailable', retryable: true };
    case 'rate_limited':
      return { class: 'rate_limited', retryable: true };
    case 'budget_exhausted':
      return { class: 'insufficient_credits', retryable: false };
    case 'image_too_large':
    case 'unsupported_format':
    case 'corrupt_input':
    case 'invalid_request':
      return { class: 'invalid_request', retryable: false };
    case null:
    case undefined:
      return { class: 'provider_unavailable', retryable: true };
    default:
      return { class: 'unknown', retryable: false };
  }
}

/** Shots up to 5s render as a 5s clip, longer shots as 10s (the only lengths Ray 3.2 offers). */
export function lumaDuration(durationSec: number): LumaDuration {
  return durationSec <= 5 ? '5s' : '10s';
}

function lumaErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'detail' in body)
    return String((body as { detail: unknown }).detail);
  return typeof body === 'string' ? body : undefined;
}

export class LumaAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['text_to_video', 'image_to_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: LumaAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<T>(
      `${BASE_URL}${path}`,
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
        errorMessage: lumaErrorMessage,
        classifyError: (status) =>
          // Docs: 413 (media too large) and 422 (bad parameter combination / media) are not
          // retryable; 502 (fetch proxy) and 503 (image ingestion) are.
          status === 413 || status === 422
            ? { errorClass: 'invalid_request', retryable: false }
            : undefined,
      },
    );
  }

  private clipPence(duration: LumaDuration): number {
    return usdToPence(USD_PER_CLIP[duration], this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') return 0;
    return this.clipPence(lumaDuration(request.durationSec));
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'text_to_video' && request.capability !== 'image_to_video') {
      throw this.invalid(`Luma adapter does not support ${request.capability}`);
    }
    if (request.durationSec < MIN_DURATION_SEC || request.durationSec > MAX_DURATION_SEC) {
      throw this.invalid(
        `Luma clips cover ${MIN_DURATION_SEC}–${MAX_DURATION_SEC}s shots (got ${request.durationSec})`,
      );
    }
    const prompt = request.prompt.trim();
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw this.invalid(`Luma prompts must be 1–${MAX_PROMPT_CHARS} characters`);
    }
    const duration = lumaDuration(request.durationSec);
    const video: Record<string, unknown> = { resolution: RESOLUTION, duration };
    if (request.capability === 'image_to_video') {
      video.keyframes = [{ url: request.imageUrl }];
      video.keyframe_indexes = [0];
    }
    const body = {
      model: MODEL,
      type: 'video',
      prompt,
      aspect_ratio: RATIO[request.aspectRatio],
      video,
    };

    const { body: created } = await this.request<LumaGeneration>('/generations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return {
      providerJobId: created.id,
      estimatedCostPence: this.clipPence(duration),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    let generation: LumaGeneration;
    try {
      ({ body: generation } = await this.request<LumaGeneration>(
        `/generations/${encodeURIComponent(providerJobId)}`,
        { method: 'GET' },
      ));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) {
        return {
          state: 'failed',
          error: { class: 'result_expired', message: 'Luma generation not found', retryable: true },
        };
      }
      throw err;
    }
    switch (generation.state) {
      case 'queued':
      case 'processing':
        return { state: 'running' };
      case 'completed': {
        const url = generation.output?.find((o) => o.type === 'video')?.url;
        if (!url) {
          return {
            state: 'failed',
            error: {
              class: 'unknown',
              message: 'Luma generation completed without a video output',
              retryable: true,
            },
          };
        }
        return {
          state: 'succeeded',
          output: {
            url,
            metadata: {
              generationId: generation.id,
              model: generation.model ?? MODEL,
              resolution: RESOLUTION,
              // Presigned URLs expire after 1 hour; Layer 3 copies the file to S3 immediately.
              urlExpiresWithinHours: 1,
            },
          },
        };
      }
      case 'failed': {
        // FAQ "Do I pay for failed generations?": content_moderated, generation_failed and
        // output_not_found are refunded, so a failure records no charge (tracked.ts default).
        // budget_exhausted "may" part-charge an amount the API does not report.
        const classified = classifyFailureCode(generation.failure_code);
        return {
          state: 'failed',
          error: {
            ...classified,
            message: `${generation.failure_code ?? 'failed'}: ${generation.failure_reason ?? 'Luma generation failed'}`,
          },
        };
      }
      default:
        // Defensive: the provider response is unvalidated JSON. An undocumented/unexpected
        // `state` value must not silently resolve to `undefined` (which callers could mistake
        // for success); treat it as a retryable unknown failure instead.
        return {
          state: 'failed',
          error: {
            class: 'unknown',
            message: `Luma generation returned an unrecognized state: ${String(generation.state)}`,
            retryable: true,
          },
        };
    }
  }

  /**
   * FAQ "Can I cancel a running generation?": "There is no cancel endpoint" — a generation runs
   * until it completes, fails or hits the 1-hour active-job TTL, and is billed if it completes.
   * Reporting a cancel that did not happen would also release the cost reservation, so this is
   * honest about it instead; callers keep the job RUNNING with its reservation.
   */
  async cancel(providerJobId: string): Promise<void> {
    throw new NotImplementedError(
      `Luma has no cancel endpoint; generation ${providerJobId} runs to completion`,
    );
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.request<unknown>('/files?limit=1', { method: 'GET' });
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
