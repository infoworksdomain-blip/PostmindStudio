import { PlatformError, type PlatformErrorClass } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type { PlatformPublisher, PublishRequest, PublishResult, PublisherDeps } from './interface';

// BACKLOG 5.2 — TikTok Content Posting API, Direct Post with FILE_UPLOAD (spec 9.2).
// Contract (developers.tiktok.com, read 2026-09-27):
//   POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/   (required before posting)
//   POST https://open.tiktokapis.com/v2/post/publish/video/init/  {post_info, source_info}
//        → data.publish_id, data.upload_url (valid 1 h)
//   PUT  upload_url  Content-Range: bytes first-last/total, sequential; 206 more / 201 done
//        chunks 5–64 MB, final chunk may absorb the remainder (≤128 MB); <5 MB = one chunk
//        total_chunk_count = floor(video_size / chunk_size)
//   POST https://open.tiktokapis.com/v2/post/publish/status/fetch/ {publish_id}
//        status PROCESSING_UPLOAD | PROCESSING_DOWNLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED
// Unaudited apps can only post privately (error unaudited_client_can_only_post_to_private_accounts).
// TikTok documents no public post URL format, so platformUrl stays null.

export const API = 'https://open.tiktokapis.com';
export const CHUNK_SIZE = 10 * 1024 * 1024; // spec 9.2 "10MB default"
const MIN_CHUNK = 5 * 1024 * 1024;
const STATUS_POLL_MS = 5_000; // spec 9.2: poll every 5 s
const STATUS_TIMEOUT_MS = 10 * 60_000; // …up to 10 minutes
/** Direct Post needs video.publish; the inbox upload (15.A2) needs video.upload. */
export const DIRECT_POST_SCOPE = 'video.publish';
export const UPLOAD_SCOPE = 'video.upload';
// The inbox init takes source_info only (no post_info), so is_aigc cannot be set by API on this
// path: the note asks the creator to switch TikTok's AI-generated content label on (operator
// decision P6: AI labels always on).
export const TIKTOK_INBOX_NOTE =
  'Sent to your TikTok inbox. Open the TikTok app, finish posting from the notification, and keep the "AI-generated content" label switched on.';

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

const NON_RETRYABLE: Record<string, PlatformErrorClass> = {
  access_token_invalid: 'needs_reconnect',
  scope_not_authorized: 'needs_reconnect',
  scope_permission_missed: 'needs_reconnect',
  spam_risk_too_many_posts: 'rate_limited',
  spam_risk_user_banned_from_posting: 'content_policy',
  reached_active_user_cap: 'quota_exceeded',
  unaudited_client_can_only_post_to_private_accounts: 'invalid_request',
  privacy_level_option_mismatch: 'invalid_request',
  url_ownership_unverified: 'invalid_request',
  invalid_param: 'invalid_request',
  invalid_params: 'invalid_request',
};

function describe(body: unknown) {
  const error = (body as TikTokEnvelope<unknown> | undefined)?.error;
  return {
    message: error?.message ? `${error.code}: ${error.message}` : error?.code,
    code: error?.code,
  };
}

function refine(status: number, code: string | undefined) {
  if (code === 'rate_limit_exceeded')
    return { errorClass: 'rate_limited' as const, retryable: true };
  if (code && NON_RETRYABLE[code]) return { errorClass: NON_RETRYABLE[code], retryable: false };
  return undefined;
}

/** fail_reason values from the status reference. */
export function classifyFailReason(reason: string | undefined): {
  errorClass: PlatformErrorClass;
  retryable: boolean;
} {
  if (!reason || reason === 'internal') return { errorClass: 'unavailable', retryable: true };
  if (reason.endsWith('_check_failed')) return { errorClass: 'invalid_media', retryable: false };
  if (reason === 'auth_removed') return { errorClass: 'needs_reconnect', retryable: false };
  if (reason.startsWith('spam_risk')) return { errorClass: 'content_policy', retryable: false };
  if (reason === 'video_pull_failed') return { errorClass: 'unavailable', retryable: true };
  return { errorClass: 'unknown', retryable: false };
}

/** Chunk plan per the media transfer guide. */
export function planChunks(size: number): {
  chunkSize: number;
  count: number;
  ranges: Array<[number, number]>;
} {
  if (size < MIN_CHUNK) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  const count = Math.max(1, Math.floor(size / CHUNK_SIZE));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * CHUNK_SIZE;
    const end = i === count - 1 ? size - 1 : start + CHUNK_SIZE - 1; // last chunk absorbs remainder
    ranges.push([start, end]);
  }
  return { chunkSize: size < CHUNK_SIZE ? size : CHUNK_SIZE, count, ranges };
}

export class TikTokPublisher implements PlatformPublisher {
  readonly platform = 'tiktok' as const;

  constructor(private readonly deps: PublisherDeps) {}

  private post<T>(path: string, token: string, body: unknown) {
    return platformRequest<TikTokEnvelope<T>>(
      `${API}${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(body),
      },
      { platform: 'tiktok', fetchImpl: this.deps.fetchImpl, describe, refine },
    );
  }

  /** 15.A2: inbox upload when Direct Post is not possible for this connection. */
  static modeFor(grantedScopes: string[] | undefined): 'direct' | 'inbox' {
    if (!grantedScopes) return 'direct';
    return !grantedScopes.includes(DIRECT_POST_SCOPE) && grantedScopes.includes(UPLOAD_SCOPE)
      ? 'inbox'
      : 'direct';
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    if (TikTokPublisher.modeFor(request.grantedScopes) === 'inbox')
      return this.publishToInbox(request, 'scope');
    const creator = (
      await this.post<{
        privacy_level_options?: string[];
        max_video_post_duration_sec?: number;
        creator_username?: string;
      }>('/v2/post/publish/creator_info/query/', token, {})
    ).body.data;
    if (
      creator?.max_video_post_duration_sec &&
      request.video.durationSec > creator.max_video_post_duration_sec
    ) {
      throw new PlatformError(
        'tiktok',
        'invalid_media',
        `This creator can post at most ${creator.max_video_post_duration_sec}s`,
        false,
      );
    }
    const options = creator?.privacy_level_options ?? [];
    const requested =
      typeof request.options?.privacyLevel === 'string'
        ? request.options.privacyLevel
        : 'PUBLIC_TO_EVERYONE';
    const privacyLevel = options.includes(requested) ? requested : options[0];
    if (!privacyLevel) {
      // The creator's privacy options forbid a direct post: hand the video to their inbox when
      // the upload scope was granted (or scopes are unknown; TikTok then refuses cleanly).
      if (!request.grantedScopes || request.grantedScopes.includes(UPLOAD_SCOPE))
        return this.publishToInbox(request, 'privacy_options');
      throw new PlatformError(
        'tiktok',
        'invalid_request',
        'TikTok returned no privacy level options',
        false,
      );
    }

    const plan = planChunks(request.video.sizeBytes);
    const init = (
      await this.post<{ publish_id?: string; upload_url?: string }>(
        '/v2/post/publish/video/init/',
        token,
        {
          post_info: {
            title: request.text,
            privacy_level: privacyLevel,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
            is_aigc: request.aiGenerated,
          },
          source_info: sourceInfo(request.video.sizeBytes, plan),
        },
      )
    ).body.data;
    if (!init?.publish_id || !init.upload_url)
      throw new PlatformError('tiktok', 'unknown', 'Init returned no publish_id/upload_url', true);
    await this.uploadChunks(init.upload_url, request, plan);

    const publishId = init.publish_id;
    const status = await this.waitFor(publishId, token, ['PUBLISH_COMPLETE']);

    // Private posts have no public id; the publish id is TikTok's handle for them.
    const postId = status.publicaly_available_post_id?.[0];
    return {
      platformPostId: postId !== undefined ? String(postId) : publishId,
      platformUrl: null,
      metadata: {
        publishId,
        privacyLevel,
        creatorUsername: creator?.creator_username ?? null,
        publiclyAvailable: postId !== undefined,
        tiktokMode: 'direct',
      },
    };
  }

  /**
   * 15.A2 (spec 9.2 / 18.1 "UPLOAD-only fallback"): POST /v2/post/publish/inbox/video/init/
   * { source_info } (scope video.upload) → publish_id + upload_url; the same chunked PUTs; then
   * status/fetch until SEND_TO_USER_INBOX ("a notification has been sent to creator's inbox to
   * complete the draft post using TikTok's editing flow"). Read 2026-09-28:
   * https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
   * https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
   */
  private async publishToInbox(
    request: PublishRequest,
    reason: 'scope' | 'privacy_options',
  ): Promise<PublishResult> {
    const token = request.accessToken;
    const plan = planChunks(request.video.sizeBytes);
    const init = (
      await this.post<{ publish_id?: string; upload_url?: string }>(
        '/v2/post/publish/inbox/video/init/',
        token,
        { source_info: sourceInfo(request.video.sizeBytes, plan) },
      )
    ).body.data;
    if (!init?.publish_id || !init.upload_url)
      throw new PlatformError(
        'tiktok',
        'unknown',
        'Inbox init returned no publish_id/upload_url',
        true,
      );
    await this.uploadChunks(init.upload_url, request, plan);
    const status = await this.waitFor(init.publish_id, token, [
      'SEND_TO_USER_INBOX',
      'PUBLISH_COMPLETE',
    ]);
    return {
      platformPostId: init.publish_id,
      platformUrl: null,
      metadata: {
        publishId: init.publish_id,
        tiktokMode: 'inbox',
        inboxReason: reason,
        inboxStatus: status.status ?? null,
        note: TIKTOK_INBOX_NOTE,
      },
    };
  }

  private async uploadChunks(
    uploadUrl: string,
    request: PublishRequest,
    plan: ReturnType<typeof planChunks>,
  ): Promise<void> {
    for (const [start, end] of plan.ranges) {
      const bytes = await request.video.read(start, end);
      await platformRequest<unknown>(
        uploadUrl,
        {
          method: 'PUT',
          headers: {
            'content-type': request.video.contentType,
            'content-length': String(bytes.byteLength),
            'content-range': `bytes ${start}-${end}/${request.video.sizeBytes}`,
          },
          body: asBody(bytes),
        },
        { platform: 'tiktok', fetchImpl: this.deps.fetchImpl, timeoutMs: 5 * 60_000 },
      );
    }
  }

  private waitFor(publishId: string, token: string, done: string[]) {
    return pollUntil(
      async () => {
        const data = (
          await this.post<{
            status?: string;
            fail_reason?: string;
            publicaly_available_post_id?: Array<number | string>;
          }>('/v2/post/publish/status/fetch/', token, { publish_id: publishId })
        ).body.data;
        if (data?.status === 'FAILED') {
          const c = classifyFailReason(data.fail_reason);
          throw new PlatformError(
            'tiktok',
            c.errorClass,
            `TikTok publish failed: ${data.fail_reason ?? 'unknown'}`,
            c.retryable,
          );
        }
        return data?.status && done.includes(data.status) ? data : undefined;
      },
      {
        intervalMs: STATUS_POLL_MS,
        timeoutMs: STATUS_TIMEOUT_MS,
        platform: 'tiktok',
        what: 'TikTok publish',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );
  }
}

function sourceInfo(videoSize: number, plan: ReturnType<typeof planChunks>) {
  return {
    source: 'FILE_UPLOAD',
    video_size: videoSize,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.count,
  };
}
