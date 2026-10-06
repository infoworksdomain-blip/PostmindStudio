import { PlatformError, type PlatformErrorClass } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type {
  CarouselPublishRequest,
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  PublisherDeps,
} from './interface';

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
/** Photo posts: photo_images takes "up to 35" URLs. */
export const TIKTOK_PHOTO_MAX = 35;
// The inbox init takes source_info only (no post_info), so is_aigc cannot be set by API on this
// path: the note asks the creator to switch TikTok's AI-generated content label on (operator
// decision P6: AI labels always on).
export const TIKTOK_INBOX_NOTE =
  'Sent to your TikTok inbox. Open the TikTok app, finish posting from the notification, and keep the "AI-generated content" label switched on.';
/** 22.7: the connection chose TikTok drafts (same inbox upload, chosen rather than a fallback). */
export const TIKTOK_DRAFTS_NOTE =
  'Sent to your TikTok drafts. Open the TikTok app, add a trending sound, finish posting from the notification, and keep the "AI-generated content" label switched on.';
/** 22.7: drafts were chosen but the connection lacks video.upload, so it was posted directly. */
export const TIKTOK_DRAFTS_RECONNECT_NOTE =
  'Reconnect TikTok to send drafts: this account did not grant the upload permission, so the post went out directly.';

/** 22.7: a TikTok connection's posting preference (platform_connections.tiktokPostMode). */
export type TikTokPostMode = 'direct' | 'drafts';
export const TIKTOK_POST_MODES: readonly TikTokPostMode[] = ['direct', 'drafts'];
/** New TikTok connections send drafts (Fastlane's default); NULL rows (pre-22.7) post directly. */
export const DEFAULT_NEW_TIKTOK_POST_MODE: TikTokPostMode = 'drafts';

export function tiktokPostModeOf(stored: string | null | undefined): TikTokPostMode {
  return stored === 'drafts' ? 'drafts' : 'direct';
}

/** Drafts need video.upload; unknown scopes (undefined) are tried and TikTok refuses cleanly. */
export function canSendDrafts(grantedScopes: string[] | undefined): boolean {
  return !grantedScopes || grantedScopes.includes(UPLOAD_SCOPE);
}

type InboxReason = 'scope' | 'privacy_options' | 'drafts';

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

  /**
   * 22.7: how this request goes out. Drafts chosen and video.upload granted → the inbox upload;
   * drafts chosen without video.upload → direct, flagged so the result says "Reconnect TikTok to
   * send drafts" (never silent); otherwise the 15.A2 scope rule.
   */
  static planFor(request: Pick<PublishRequest, 'grantedScopes' | 'tiktokPostMode'>): {
    mode: 'direct' | 'inbox';
    reason?: InboxReason;
    draftsUnavailable: boolean;
  } {
    const wantsDrafts = request.tiktokPostMode === 'drafts';
    if (wantsDrafts && canSendDrafts(request.grantedScopes))
      return { mode: 'inbox', reason: 'drafts', draftsUnavailable: false };
    const mode = TikTokPublisher.modeFor(request.grantedScopes);
    return {
      mode,
      ...(mode === 'inbox' && { reason: 'scope' as const }),
      draftsUnavailable: wantsDrafts,
    };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    const route = TikTokPublisher.planFor(request);
    if (route.mode === 'inbox') return this.publishToInbox(request, route.reason ?? 'scope');
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
        ...draftsFallback(route.draftsUnavailable),
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
   * 22.7 (re-read 2026-10-06): the same endpoint is the "Send to TikTok drafts" path. Its body is
   * `source_info` only (source FILE_UPLOAD with video_size, chunk_size, total_chunk_count, or
   * PULL_FROM_URL with video_url); there is no post_info, so no title, privacy or is_aigc. "Users
   * must click inbox notifications to continue editing and complete posting."
   */
  private async publishToInbox(
    request: PublishRequest,
    reason: InboxReason,
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
        note: reason === 'drafts' ? TIKTOK_DRAFTS_NOTE : TIKTOK_INBOX_NOTE,
      },
    };
  }

  /**
   * 21.6 photo post. Content Posting API, "Photo Post" reference and media transfer guide, read
   * 2026-10-04: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post and
   * https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
   *   POST /v2/post/publish/content/init/ {media_type:"PHOTO", post_mode:"DIRECT_POST"|"MEDIA_UPLOAD",
   *        post_info:{title (≤90), description (≤4000), privacy_level, disable_comment,
   *        auto_add_music}, source_info:{source:"PULL_FROM_URL", photo_images:[≤35 URLs],
   *        photo_cover_index}} → data.publish_id; then status/fetch as for video.
   *   Images: JPEG or WebP, ≤20 MB, ≤1080p; the URLs must be on a domain or URL prefix verified
   *   for the app in the TikTok developer portal (else url_ownership_unverified). DIRECT_POST
   *   needs video.publish; MEDIA_UPLOAD (to the creator's inbox) needs video.upload.
   */
  async publishCarousel(request: CarouselPublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    if (request.slides.length < 1 || request.slides.length > TIKTOK_PHOTO_MAX)
      throw new PlatformError(
        'tiktok',
        'invalid_media',
        `TikTok photo posts take 1 to ${TIKTOK_PHOTO_MAX} images (this one has ${request.slides.length})`,
        false,
      );
    const sourceInfo = {
      source: 'PULL_FROM_URL',
      photo_images: request.slides.map((s) => s.jpegUrl),
      photo_cover_index: 0,
    };
    const title = [...(request.caption.split('\n')[0] ?? '')].slice(0, 90).join('');
    const description = [...request.text].slice(0, 4000).join('');
    // 22.7: drafts → post_mode MEDIA_UPLOAD (photo post reference, re-read 2026-10-06: "Upload
    // content to TikTok for users to complete the post using TikTok's editing flow. Users will
    // receive an inbox notification"; scope video.upload; title and description are carried into
    // the editing flow).
    const route = TikTokPublisher.planFor(request);
    let mode: 'direct' | 'inbox' = route.mode;
    let privacyLevel: string | undefined;
    if (mode === 'direct') {
      const creator = (
        await this.post<{ privacy_level_options?: string[] }>(
          '/v2/post/publish/creator_info/query/',
          token,
          {},
        )
      ).body.data;
      const options = creator?.privacy_level_options ?? [];
      const requested =
        typeof request.options?.privacyLevel === 'string'
          ? request.options.privacyLevel
          : 'PUBLIC_TO_EVERYONE';
      privacyLevel = options.includes(requested) ? requested : options[0];
      if (!privacyLevel) mode = 'inbox';
    }
    const body =
      mode === 'direct'
        ? {
            media_type: 'PHOTO',
            post_mode: 'DIRECT_POST',
            post_info: {
              title,
              description,
              privacy_level: privacyLevel,
              disable_comment: false,
              auto_add_music: true,
            },
            source_info: sourceInfo,
            ...(request.aiGenerated && { is_aigc: true }),
          }
        : {
            media_type: 'PHOTO',
            post_mode: 'MEDIA_UPLOAD',
            post_info: { title, description },
            source_info: sourceInfo,
            ...(request.aiGenerated && { is_aigc: true }),
          };
    const init = (
      await this.post<{ publish_id?: string }>('/v2/post/publish/content/init/', token, body)
    ).body.data;
    if (!init?.publish_id)
      throw new PlatformError('tiktok', 'unknown', 'Photo init returned no publish_id', true);
    const status = await this.waitFor(
      init.publish_id,
      token,
      mode === 'direct' ? ['PUBLISH_COMPLETE'] : ['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'],
    );
    const postId = status.publicaly_available_post_id?.[0];
    return {
      platformPostId: postId !== undefined ? String(postId) : init.publish_id,
      platformUrl: null,
      metadata: {
        publishId: init.publish_id,
        tiktokMode: mode,
        mediaType: 'PHOTO',
        ...(privacyLevel && { privacyLevel }),
        ...(mode === 'inbox' && {
          inboxReason: route.reason ?? 'privacy_options',
          note: route.reason === 'drafts' ? TIKTOK_DRAFTS_NOTE : TIKTOK_INBOX_NOTE,
        }),
        ...(mode === 'direct' && draftsFallback(route.draftsUnavailable)),
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

/** 22.7: drafts were chosen but could not be used (no video.upload): say so in the result. */
function draftsFallback(unavailable: boolean): Record<string, string> {
  return unavailable
    ? { draftsUnavailable: 'missing_scope', draftsNote: TIKTOK_DRAFTS_RECONNECT_NOTE }
    : {};
}

function sourceInfo(videoSize: number, plan: ReturnType<typeof planChunks>) {
  return {
    source: 'FILE_UPLOAD',
    video_size: videoSize,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.count,
  };
}
