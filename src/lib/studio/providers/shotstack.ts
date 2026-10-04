import { ConfigurationError, ProviderError } from '../../errors';
import { logger } from '../../logger';
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

// BACKLOG 2.8 — Shotstack composition (Layers 6–7). Studio builds the edit decision list
// (Phase 3.6) and POSTs it; Shotstack renders. Contract from shotstack.io/docs/api (read
// 2026-09-27):
//   base https://api.shotstack.io/edit/{stage|v1}, header x-api-key
//   POST /render → 201 { response: { id } }
//   GET  /render/{id} → response.status queued|fetching|preprocessing|rendering|generating|
//        saving|done|failed; response.url (temporary, deleted after 24h); response.error
// The `stage` environment is the watermarked sandbox.

export const PROVIDER_ID = 'shotstack';
const ENVIRONMENTS = ['stage', 'v1'] as const;
export type ShotstackEnvironment = (typeof ENVIRONMENTS)[number];
/**
 * BACKLOG 20.25: Shotstack's list price (shotstack.io/pricing, read 2026-10-03): pay-as-you-go
 * $0.30 per rendered minute (subscriptions from $0.20), "1 credit is equal to 1 minute of video,
 * regardless of resolution", and a render is "rounded down to the second" (30 s = 0.5 credits).
 * The spec 6.5 estimate (£0.02 per output second, 60p for a 30 s short) was 5× the list price
 * and was what Studio recorded, since Shotstack reports no per-render cost. The pay-as-you-go
 * rate is used so the estimate never undercounts on a subscription.
 */
export const USD_PER_RENDERED_MINUTE = 0.3;
const TYPICAL_LATENCY_SEC = 120; // spec 5.1: 30s–5min per output
const TIMEOUT_MS = 30_000;

const RUNNING_STATES = new Set([
  'queued',
  'fetching',
  'preprocessing',
  'rendering',
  'generating',
  'saving',
]);

/**
 * A failed render caused by fetching our assets (Shotstack downloads every clip, voice and font
 * from storage) or by a transient network fault is worth retrying; anything else (a bad edit, an
 * unsupported asset) is not. Production 2026-10-04: "5 asset(s) failed to download … Connection
 * timeout" from R2 failed a whole project after its clips were paid for.
 */
const TRANSIENT_RENDER_FAILURE =
  /failed to download|error occurred downloading|connection (timeout|timed out|reset|refused)|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|temporarily unavailable|\b50[234]\b/i;

export function classifyRenderFailure(message: string): {
  class: 'timeout' | 'unknown';
  retryable: boolean;
} {
  return TRANSIENT_RENDER_FAILURE.test(message)
    ? { class: 'timeout', retryable: true }
    : { class: 'unknown', retryable: false };
}

interface ShotstackEnvelope<T> {
  success: boolean;
  message: string;
  response: T;
}

interface RenderStatus {
  id: string;
  status: string;
  url?: string;
  error?: string;
  duration?: number;
  renderTime?: number;
  poster?: string;
  thumbnail?: string;
}

export interface ShotstackAdapterOptions {
  apiKey: string;
  environment: string;
  /** STUDIO_USD_TO_GBP_RATE: Shotstack bills in USD. */
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function shotstackErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; response?: { error?: unknown } };
    if (typeof b.response?.error === 'string') return b.response.error;
    if (typeof b.message === 'string') return b.message;
  }
  return typeof body === 'string' ? body : undefined;
}

export class ShotstackAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['composition'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ShotstackAdapterOptions) {
    if (!(ENVIRONMENTS as readonly string[]).includes(options.environment)) {
      throw new ConfigurationError(
        `SHOTSTACK_ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')}`,
      );
    }
    this.baseUrl = `https://api.shotstack.io/edit/${options.environment}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<ShotstackEnvelope<T>>(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: {
          'x-api-key': this.options.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: shotstackErrorMessage,
      },
    );
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'composition') return 0;
    // Billed by the whole second, rounded down (pricing FAQ); at least one second.
    const seconds = Math.max(1, Math.floor(request.outputDurationSec));
    return usdToPence((seconds / 60) * USD_PER_RENDERED_MINUTE, this.options.usdToGbpRate);
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'composition') {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'invalid_request', retryable: false },
        `Shotstack adapter does not support ${request.capability}`,
      );
    }
    const { body } = await this.request<{ id?: string; message?: string }>('/render', {
      method: 'POST',
      body: JSON.stringify(request.edit),
    });
    const id = body.response?.id;
    if (!id) {
      throw providerError(
        PROVIDER_ID,
        { errorClass: 'unknown', retryable: true },
        'Shotstack render response had no id',
      );
    }
    return {
      providerJobId: id,
      estimatedCostPence: this.estimateCostPence(request),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    const { body } = await this.request<RenderStatus>(
      `/render/${encodeURIComponent(providerJobId)}?data=false`,
      {
        method: 'GET',
      },
    );
    const render = body.response;
    if (RUNNING_STATES.has(render.status)) return { state: 'running' };
    if (render.status === 'done' && render.url) {
      return {
        state: 'succeeded',
        output: {
          url: render.url,
          metadata: {
            renderId: render.id,
            environment: this.options.environment,
            durationSec: render.duration,
            renderTimeMs: render.renderTime,
            poster: render.poster,
            thumbnail: render.thumbnail,
            urlExpiresWithinHours: 24,
          },
        },
      };
    }
    const message = render.error ?? `Shotstack render ended with status ${render.status}`;
    return { state: 'failed', error: { ...classifyRenderFailure(message), message } };
  }

  /**
   * Shotstack documents no cancel endpoint. The render runs to completion and its output is
   * never used; cancelTracked still marks the provider_jobs row CANCELLED.
   */
  async cancel(providerJobId: string): Promise<void> {
    logger.info(
      { providerJobId },
      '[shotstack] no cancel endpoint; render will complete and be discarded',
    );
  }

  /**
   * No health endpoint is documented. GET /templates is a documented, read-only, uncharged
   * call that exercises auth and availability.
   */
  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      await this.request<unknown>('/templates', { method: 'GET' });
      return { healthy: true };
    } catch (err) {
      const cls = err instanceof ProviderError ? err.errorClass : 'unknown';
      return { healthy: false, reason: `${cls}: ${(err as Error).message}` };
    }
  }
}
