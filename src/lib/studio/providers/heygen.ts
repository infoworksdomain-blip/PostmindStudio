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
import { providerError, type ErrorClassification } from './provider-errors';

// BACKLOG 13.32 — HeyGen (Layer 3 AI_AVATAR; spec 6.3, 6.4). Contract from HeyGen's developer
// docs and OpenAPI spec (read 2026-09-27):
//   https://developers.heygen.com/reference/create-video   (POST /v3/videos, type "avatar")
//   https://developers.heygen.com/reference/get-video      (GET /v3/videos/{video_id})
//   https://developers.heygen.com/reference/get-current-user (GET /v3/users/me)
//   https://developers.heygen.com/audio-to-video           (audio_url lip-sync)
//   https://developers.heygen.com/docs/error-codes         ({ error: { code, message } })
//   https://developers.heygen.com/docs/usage-limits        (audio WAV/MP3 ≤ 50 MB, public URL)
//   https://developers.heygen.com/docs/enterprise-pricing  (price source, below)
//   https://developers.heygen.com/openapi/external-api.json (schemas: CreateVideoFromAvatar,
//     VideoDetail, VideoStatus pending|processing|completed|failed, UserInfoResponse)
//   base https://api.heygen.com, header x-api-key.
//
// SPEC DRIFT: the backlog names "video generate v2". HeyGen retires every v1/v2 endpoint on
// 2026-10-31 (https://developers.heygen.com/endpoint-version-comparison), so this adapter uses
// the v3 replacement POST /v3/videos.
//
// DESIGN: the avatar lip-syncs to the shot's Layer 4 narration (audio_url = presigned URL of the
// ElevenLabs voice asset), so the presenter speaks in the brand voice and the composer's muted
// clip + separate voice track stay in sync. No HeyGen voice is used or billed.

export const PROVIDER_ID = 'heygen';
export const BASE_URL = 'https://api.heygen.com';
export const RESOLUTION = '1080p';
// Price source: HeyGen "Enterprise Pricing" — Avatar IV (the default v3 engine) is
// 0.1 credits/sec for photo, digital-twin and studio avatars, and "1 credit costs $0.50 …
// Photo Avatar video at 0.1 credits / sec is the equivalent of $0.05 / sec" on self-serve.
// Self-serve rates are only shown in the dashboard (app.heygen.com/developers/api?modal=pricing).
const USD_PER_SECOND = 0.05;
const MAX_DURATION_SEC = 30 * 60; // usage-limits: 30 minutes per scene
// Render time is not documented; a conservative figure for deadline checks only.
const TYPICAL_LATENCY_SEC = 300;
const TIMEOUT_MS = 30_000;

// VideoAspectRatio enum: 16:9, 9:16, 4:5, 5:4, 1:1, auto — every Studio ratio is supported.
const RATIO: Record<AspectRatio, string> = {
  '9:16': '9:16',
  '16:9': '16:9',
  '1:1': '1:1',
  '4:5': '4:5',
};

interface HeyGenVideoDetail {
  id: string;
  status: string;
  video_url?: string | null;
  thumbnail_url?: string | null;
  duration?: number | null;
  failure_code?: string | null;
  failure_message?: string | null;
}

interface HeyGenUser {
  billing_type?: 'wallet' | 'subscription' | 'usage_based' | null;
  wallet?: { currency: string; remaining_balance?: number | null } | null;
  usage_based?: {
    spending_current_usd?: number | null;
    spending_cap_usd?: number | null;
  } | null;
}

export interface HeyGenAdapterOptions {
  apiKey: string;
  /** Stock (or brand) avatar look id used when a request names none (HEYGEN_AVATAR_ID). */
  defaultAvatarId: string;
  usdToGbpRate: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const CREDIT_CODES = new Set([
  'insufficient_credit',
  'quota_exceeded',
  'trial_limit_exceeded',
  'subscription_required',
  'plan_upgrade_required',
]);
const POLICY_CODES = new Set(['content_policy_violation', 'avatar_not_usable']);
const TRANSIENT_CODES = new Set([
  'internal_error',
  'voice_provider_error',
  'service_unavailable',
  'gateway_timeout',
  'resource_not_ready',
  'request_in_progress',
]);
const INVALID_CODES = new Set([
  'invalid_parameter',
  'download_failed',
  'avatar_not_found',
  'avatar_consent_required',
  'avatar_expired',
  'voice_not_usable',
  'script_too_short',
  'tts_text_invalid',
]);

/** Map a code from HeyGen's error-code catalogue (sync `error.code` or async `failure_code`). */
export function classifyHeyGenCode(code: string | null | undefined): {
  class: ProviderErrorClass;
  retryable: boolean;
} {
  if (!code || TRANSIENT_CODES.has(code)) return { class: 'provider_unavailable', retryable: true };
  if (code === 'rate_limit_exceeded') return { class: 'rate_limited', retryable: true };
  if (POLICY_CODES.has(code)) return { class: 'content_policy', retryable: false };
  if (CREDIT_CODES.has(code)) return { class: 'insufficient_credits', retryable: false };
  if (INVALID_CODES.has(code)) return { class: 'invalid_request', retryable: false };
  return { class: 'unknown', retryable: false };
}

function errorBody(body: unknown): { code?: string; message?: string } | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error: unknown }).error;
    if (error && typeof error === 'object') return error as { code?: string; message?: string };
  }
  return undefined;
}

function heygenErrorMessage(body: unknown): string | undefined {
  const error = errorBody(body);
  if (error?.message) return error.code ? `${error.code}: ${error.message}` : error.message;
  return typeof body === 'string' ? body : undefined;
}

/** Refine the HTTP status with the documented error code where it changes the class. */
function classifyHeyGenError(status: number, body: unknown): ErrorClassification | undefined {
  const code = errorBody(body)?.code;
  if (!code || status >= 500 || status === 401 || status === 403) return undefined;
  if (code === 'rate_limit_exceeded' || code === 'request_in_progress') return undefined;
  const classified = classifyHeyGenCode(code);
  if (classified.class === 'unknown') return undefined;
  return { errorClass: classified.class, retryable: classified.retryable };
}

export class HeyGenAdapter implements ProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly capabilities: readonly ProviderCapability[] = ['avatar_video'];
  readonly typicalLatencySec = TYPICAL_LATENCY_SEC;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: HeyGenAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private request<T>(path: string, init: RequestInit) {
    return httpJson<{ data: T }>(
      `${BASE_URL}${path}`,
      {
        ...init,
        headers: { 'x-api-key': this.options.apiKey, 'Content-Type': 'application/json' },
      },
      {
        providerId: PROVIDER_ID,
        fetchImpl: this.fetchImpl,
        timeoutMs: TIMEOUT_MS,
        errorMessage: heygenErrorMessage,
        classifyError: classifyHeyGenError,
      },
    );
  }

  private secondsToPence(seconds: number): number {
    return usdToPence(Math.ceil(seconds) * USD_PER_SECOND, this.options.usdToGbpRate);
  }

  estimateCostPence(request: ProviderRequest): number {
    if (request.capability !== 'avatar_video') return 0;
    return this.secondsToPence(request.durationSec);
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    if (request.capability !== 'avatar_video') {
      throw this.invalid(`HeyGen adapter does not support ${request.capability}`);
    }
    if (request.durationSec <= 0 || request.durationSec > MAX_DURATION_SEC) {
      throw this.invalid(`HeyGen renders up to ${MAX_DURATION_SEC}s (got ${request.durationSec})`);
    }
    if (!/^https:\/\//.test(request.audioUrl)) {
      throw this.invalid('HeyGen needs a public HTTPS audio_url for lip-sync');
    }
    const body = {
      type: 'avatar',
      avatar_id: request.avatarId ?? this.options.defaultAvatarId,
      audio_url: request.audioUrl,
      aspect_ratio: RATIO[request.aspectRatio],
      resolution: RESOLUTION,
      output_format: 'mp4',
      ...(request.shotId && { title: `PostMind Studio shot ${request.shotId}` }),
    };
    const { body: created } = await this.request<{ video_id: string; status: string }>(
      '/v3/videos',
      { method: 'POST', body: JSON.stringify(body) },
    );
    return {
      providerJobId: created.data.video_id,
      estimatedCostPence: this.secondsToPence(request.durationSec),
      estimatedReadyAt: new Date(this.now() + TYPICAL_LATENCY_SEC * 1000),
    };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    let video: HeyGenVideoDetail;
    try {
      ({
        body: { data: video },
      } = await this.request<HeyGenVideoDetail>(`/v3/videos/${encodeURIComponent(providerJobId)}`, {
        method: 'GET',
      }));
    } catch (err) {
      if (err instanceof ProviderError && err.details?.status === 404) {
        return {
          state: 'failed',
          error: { class: 'result_expired', message: 'HeyGen video not found', retryable: true },
        };
      }
      throw err;
    }
    if (video.status === 'failed') {
      return {
        state: 'failed',
        error: {
          ...classifyHeyGenCode(video.failure_code),
          message: `${video.failure_code ?? 'failed'}: ${video.failure_message ?? 'HeyGen render failed'}`,
        },
      };
    }
    // "pending" / "processing" per VideoStatus; the create response also shows "waiting".
    if (video.status !== 'completed') return { state: 'running' };
    if (!video.video_url) {
      return {
        state: 'failed',
        error: {
          class: 'unknown',
          message: 'HeyGen video completed without a video_url',
          retryable: true,
        },
      };
    }
    const duration = typeof video.duration === 'number' ? video.duration : undefined;
    return {
      state: 'succeeded',
      output: {
        url: video.video_url,
        metadata: {
          videoId: video.id,
          resolution: RESOLUTION,
          thumbnailUrl: video.thumbnail_url ?? null,
          ...(duration !== undefined && {
            durationSec: duration,
            costPence: this.secondsToPence(duration),
          }),
        },
      },
    };
  }

  /**
   * HeyGen documents no way to stop a render: DELETE /v3/videos/{id} "permanently deletes a
   * video and its associated files" and says nothing about in-progress renders or refunds.
   * Deleting and reporting a cancel would release a reservation HeyGen may still bill.
   */
  async cancel(providerJobId: string): Promise<void> {
    throw new NotImplementedError(
      `HeyGen documents no render cancel; video ${providerJobId} runs to completion`,
    );
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const {
        body: { data: user },
      } = await this.request<HeyGenUser>('/v3/users/me', { method: 'GET' });
      const balance = user.wallet?.remaining_balance;
      if (user.billing_type === 'wallet' && typeof balance === 'number' && balance <= 0) {
        return { healthy: false, reason: 'insufficient_credits: HeyGen wallet balance is 0' };
      }
      const usage = user.usage_based;
      if (
        user.billing_type === 'usage_based' &&
        typeof usage?.spending_cap_usd === 'number' &&
        typeof usage.spending_current_usd === 'number' &&
        usage.spending_current_usd >= usage.spending_cap_usd
      ) {
        return { healthy: false, reason: 'insufficient_credits: HeyGen spending cap reached' };
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
