import { PlatformError, type PlatformErrorClass } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type {
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  PublisherDeps,
  TakedownRequest,
} from './interface';

// BACKLOG 5.3 / 5.7 — Instagram Reels and Facebook Reels via the Meta Graph API (spec 9.3, 9.7).
// Contract (developers.facebook.com, read 2026-09-27; Graph API v26.0 is current):
//   Instagram: POST /{ig-user-id}/media {media_type=REELS, video_url, caption, share_to_feed}
//              → container id; GET /{container}?fields=status_code,status (EXPIRED|ERROR|FINISHED|
//              IN_PROGRESS|PUBLISHED; Meta: poll once a minute, up to 5 minutes);
//              POST /{ig-user-id}/media_publish {creation_id} → media id;
//              GET /{media-id}?fields=permalink,shortcode,timestamp
//   Facebook:  POST /{page-id}/video_reels upload_phase=start → {video_id, upload_url};
//              POST rupload.facebook.com/video-upload/{v}/{video-id} with header file_url (hosted);
//              POST /{page-id}/video_reels upload_phase=finish {video_id, video_state=PUBLISHED,
//              description}; GET /{video-id}?fields=status
// 15.A1 feed video (read 2026-09-28):
//   Instagram feed: the IG User Media reference lists media_type CAROUSEL | REELS | STORIES only
//              (https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media),
//              so a single feed video is a REELS container with share_to_feed=true (it appears
//              in both Feed and Reels); the rest of the flow is the Reel flow above.
//   Facebook feed (spec 9.7 "resumable upload flow"): Page Videos reference v26.0
//              (https://developers.facebook.com/docs/graph-api/reference/page/videos/):
//              POST /{page-id}/videos upload_phase=start file_size → {upload_session_id,
//              video_id, start_offset, end_offset}; upload_phase=transfer upload_session_id,
//              start_offset, video_file_chunk (form data) → next {start_offset, end_offset} until
//              they are equal; upload_phase=finish upload_session_id, title, description →
//              {success}. Host graph-video.facebook.com as in the Video API publishing guide
//              (https://developers.facebook.com/docs/video-api/guides/publishing).
// Tokens: PostMind Core pushes them to /api/studio/internal/channels (see MetaCredentialSource).

export const GRAPH_HOST = 'https://graph.facebook.com';
export const RUPLOAD_HOST = 'https://rupload.facebook.com';
export const GRAPH_VIDEO_HOST = 'https://graph-video.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v26.0';

export interface MetaCredentials {
  accessToken: string;
  /** IG business user id (instagram) or Page id (facebook). */
  accountId: string;
  accountName?: string;
}

/**
 * Where Studio gets Meta tokens for a connected IG account / FB page. Operator decision
 * 2026-09-27: PostMind Core runs the Meta login and pushes the tokens to Studio's internal
 * endpoints exactly as it does for Engagement (handover 9.5 / 14.13); they are stored envelope-
 * encrypted in platform_connections (meta-credentials.ts reads them).
 */
export interface MetaCredentialSource {
  getCredentials(input: MetaAccountRef): Promise<MetaCredentials>;
  /** Meta refused the token (Graph error 190): mark the connection needs_reconnect. */
  reportTokenRejected?(input: MetaAccountRef): Promise<void>;
}

export interface MetaAccountRef {
  organisationId: string;
  platform: 'instagram' | 'facebook';
  platformAccountId: string;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
}

// Instagram error-code guidance (IG error-codes reference).
const IG_SUBCODES: Record<number, { errorClass: PlatformErrorClass; retryable: boolean }> = {
  2207003: { errorClass: 'unavailable', retryable: true }, // download timeout
  2207001: { errorClass: 'unavailable', retryable: true }, // server error
  2207032: { errorClass: 'unavailable', retryable: true }, // container creation failed
  2207008: { errorClass: 'unavailable', retryable: true },
  2207020: { errorClass: 'unavailable', retryable: true }, // container expired → new container on retry
  2207053: { errorClass: 'unavailable', retryable: true },
  2207042: { errorClass: 'quota_exceeded', retryable: false }, // daily limit
  2207051: { errorClass: 'content_policy', retryable: false }, // spam
  2207050: { errorClass: 'content_policy', retryable: false }, // restricted account
  2207026: { errorClass: 'invalid_media', retryable: false }, // unsupported format
  2207052: { errorClass: 'invalid_request', retryable: false }, // URI not fetchable
  2207010: { errorClass: 'invalid_request', retryable: false }, // caption too long
};

function describe(body: unknown) {
  const e = (body as GraphError | undefined)?.error;
  // Code 190 (invalid/expired OAuth token) wins over its subcodes (458 app removed, 460 password
  // changed, 463 expired, …): every one of them means the connection must be re-authorised.
  // https://developers.facebook.com/docs/graph-api/guides/error-handling
  if (e?.code === 190) return { message: e.message, code: '190' };
  return {
    message: e?.message,
    code: e?.error_subcode ? String(e.error_subcode) : e?.code ? String(e.code) : undefined,
  };
}

function refine(status: number, code: string | undefined) {
  if (code && IG_SUBCODES[Number(code)]) return IG_SUBCODES[Number(code)];
  if (code === '190') return { errorClass: 'needs_reconnect' as const, retryable: false }; // invalid token
  if (code === '613' || code === '4' || code === '17' || code === '32')
    return { errorClass: 'rate_limited' as const, retryable: true };
  return undefined;
}

interface MetaPublisherDeps extends PublisherDeps {
  graphVersion?: string;
}

abstract class MetaPublisher implements PlatformPublisher {
  abstract readonly platform: 'instagram_reel' | 'instagram_feed' | 'facebook' | 'facebook_feed';

  protected get metaPlatform(): 'instagram' | 'facebook' {
    return this.platform === 'facebook' || this.platform === 'facebook_feed'
      ? 'facebook'
      : 'instagram';
  }
  protected readonly version: string;

  constructor(protected readonly deps: MetaPublisherDeps) {
    this.version = deps.graphVersion ?? DEFAULT_GRAPH_VERSION;
  }

  protected graph<T>(
    path: string,
    token: string,
    init: { method?: string; params?: Record<string, string> } = {},
  ) {
    const url = new URL(`${GRAPH_HOST}/${this.version}${path}`);
    const body = new URLSearchParams({ ...init.params, access_token: token });
    const isGet = (init.method ?? 'GET') === 'GET';
    if (isGet) body.forEach((v, k) => url.searchParams.set(k, v));
    return platformRequest<T>(
      url.toString(),
      isGet
        ? { method: 'GET' }
        : {
            method: init.method,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          },
      {
        platform: this.metaPlatform,
        fetchImpl: this.deps.fetchImpl,
        describe,
        refine,
      },
    );
  }

  abstract publish(request: PublishRequest): Promise<PublishResult>;

  /** DELETE /{ig-media-id} (needs instagram_manage_contents) / DELETE /{video-id} (Facebook). */
  async takedown(request: TakedownRequest): Promise<void> {
    await this.graph<unknown>(
      `/${encodeURIComponent(request.platformPostId)}`,
      request.accessToken,
      {
        method: 'DELETE',
      },
    );
  }
}

export class InstagramReelPublisher extends MetaPublisher {
  /** instagram_feed publishes the same REELS container (see the header: no feed VIDEO type). */
  constructor(
    deps: MetaPublisherDeps,
    readonly platform: 'instagram_reel' | 'instagram_feed' = 'instagram_reel',
  ) {
    super(deps);
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    const igUser = encodeURIComponent(request.accountId);
    const container = await this.graph<{ id?: string }>(`/${igUser}/media`, token, {
      method: 'POST',
      params: {
        media_type: 'REELS',
        video_url: request.video.signedUrl,
        caption: request.text,
        share_to_feed: 'true',
        is_ai_generated: String(request.aiGenerated),
      },
    });
    const containerId = container.body.id;
    if (!containerId)
      throw new PlatformError('instagram', 'unknown', 'Container creation returned no id', true);

    await pollUntil(
      async () => {
        const res = await this.graph<{ status_code?: string; status?: string }>(
          `/${encodeURIComponent(containerId)}`,
          token,
          {
            params: { fields: 'status_code,status' },
          },
        );
        const code = res.body.status_code;
        if (code === 'ERROR')
          throw new PlatformError(
            'instagram',
            'invalid_media',
            `Container error: ${res.body.status ?? 'unknown'}`,
            false,
          );
        if (code === 'EXPIRED')
          throw new PlatformError(
            'instagram',
            'unavailable',
            'Container expired before publishing',
            true,
          );
        return code === 'FINISHED' ? code : undefined;
      },
      {
        intervalMs: 60_000,
        timeoutMs: 5 * 60_000,
        platform: 'instagram',
        what: 'Instagram media processing',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );

    const published = await this.graph<{ id?: string }>(`/${igUser}/media_publish`, token, {
      method: 'POST',
      params: { creation_id: containerId },
    });
    const mediaId = published.body.id;
    if (!mediaId)
      throw new PlatformError('instagram', 'unknown', 'Publish returned no media id', true);
    const media = await this.graph<{ permalink?: string; shortcode?: string; timestamp?: string }>(
      `/${encodeURIComponent(mediaId)}`,
      token,
      {
        params: { fields: 'permalink,shortcode,timestamp' },
      },
    );
    return {
      platformPostId: mediaId,
      platformUrl: media.body.permalink ?? null,
      metadata: {
        containerId,
        shortcode: media.body.shortcode ?? null,
        timestamp: media.body.timestamp ?? null,
      },
    };
  }
}

export class FacebookReelPublisher extends MetaPublisher {
  readonly platform = 'facebook' as const;

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    const page = encodeURIComponent(request.accountId);
    const start = await this.graph<{ video_id?: string }>(`/${page}/video_reels`, token, {
      method: 'POST',
      params: { upload_phase: 'start' },
    });
    const videoId = start.body.video_id;
    if (!videoId)
      throw new PlatformError(
        'facebook',
        'unknown',
        'Reel upload start returned no video_id',
        true,
      );

    await platformRequest<{ success?: boolean }>(
      `${RUPLOAD_HOST}/video-upload/${this.version}/${encodeURIComponent(videoId)}`,
      {
        method: 'POST',
        headers: { authorization: `OAuth ${token}`, file_url: request.video.signedUrl },
      },
      {
        platform: 'facebook',
        fetchImpl: this.deps.fetchImpl,
        describe,
        refine,
        timeoutMs: 5 * 60_000,
      },
    );

    const finish = await this.graph<{ success?: boolean; post_id?: string }>(
      `/${page}/video_reels`,
      token,
      {
        method: 'POST',
        params: {
          upload_phase: 'finish',
          video_id: videoId,
          video_state: 'PUBLISHED',
          description: request.text,
        },
      },
    );

    await pollUntil(
      async () => {
        const res = await this.graph<{
          status?: {
            video_status?: string;
            publishing_phase?: { status?: string; publish_status?: string };
          };
        }>(`/${encodeURIComponent(videoId)}`, token, { params: { fields: 'status' } });
        const s = res.body.status;
        if (
          s?.video_status === 'error' ||
          s?.video_status === 'upload_failed' ||
          s?.publishing_phase?.status === 'error'
        ) {
          throw new PlatformError(
            'facebook',
            'invalid_media',
            `Reel processing failed (${s.video_status})`,
            false,
          );
        }
        if (s?.video_status === 'expired')
          throw new PlatformError('facebook', 'unavailable', 'Reel upload expired', true);
        return s?.publishing_phase?.publish_status === 'published' ? s : undefined;
      },
      {
        intervalMs: 10_000,
        timeoutMs: 10 * 60_000,
        platform: 'facebook',
        what: 'Facebook Reel processing',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );

    let permalink: string | null = null;
    const postId = finish.body.post_id;
    if (postId) {
      const post = await this.graph<{ permalink_url?: string }>(
        `/${encodeURIComponent(postId)}`,
        token,
        { params: { fields: 'permalink_url' } },
      );
      permalink = post.body.permalink_url ?? null;
    }
    return {
      platformPostId: videoId,
      platformUrl: permalink,
      metadata: { postId: postId ?? null },
    };
  }
}

interface ChunkWindow {
  upload_session_id?: string;
  video_id?: string;
  start_offset?: string;
  end_offset?: string;
}

/** 15.A1 — Facebook feed video via the Page Videos chunked upload (upload_phase start/transfer/finish). */
export class FacebookFeedPublisher extends MetaPublisher {
  readonly platform = 'facebook_feed' as const;

  private videos<T>(page: string, token: string, form: FormData | URLSearchParams) {
    form.set('access_token', token);
    return platformRequest<T>(
      `${GRAPH_VIDEO_HOST}/${this.version}/${page}/videos`,
      { method: 'POST', body: form },
      {
        platform: 'facebook',
        fetchImpl: this.deps.fetchImpl,
        describe,
        refine,
        timeoutMs: 5 * 60_000,
      },
    );
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    const page = encodeURIComponent(request.accountId);
    const { video } = request;
    const start = await this.videos<ChunkWindow>(
      page,
      token,
      new URLSearchParams({ upload_phase: 'start', file_size: String(video.sizeBytes) }),
    );
    const sessionId = start.body.upload_session_id;
    const videoId = start.body.video_id;
    if (!sessionId || !videoId)
      throw new PlatformError('facebook', 'unknown', 'Upload start returned no session', true);

    let from = Number(start.body.start_offset ?? 0);
    let to = Number(start.body.end_offset ?? 0);
    // Meta names the next byte window each time; the upload is done when the window is empty.
    for (let guard = 0; from < to; guard += 1) {
      if (!Number.isFinite(from) || !Number.isFinite(to) || guard > 10_000)
        throw new PlatformError('facebook', 'unknown', 'Invalid upload window from Meta', true);
      const bytes = await video.read(from, Math.min(to, video.sizeBytes) - 1);
      const form = new FormData();
      form.set('upload_phase', 'transfer');
      form.set('upload_session_id', sessionId);
      form.set('start_offset', String(from));
      form.set('video_file_chunk', new Blob([asBody(bytes)], { type: video.contentType }), 'chunk');
      const next = await this.videos<ChunkWindow>(page, token, form);
      from = Number(next.body.start_offset ?? to);
      to = Number(next.body.end_offset ?? to);
    }

    const finish = await this.videos<{ success?: boolean }>(
      page,
      token,
      new URLSearchParams({
        upload_phase: 'finish',
        upload_session_id: sessionId,
        description: request.text,
        ...(request.title && { title: request.title }),
      }),
    );
    if (finish.body.success === false)
      throw new PlatformError('facebook', 'unknown', 'Upload finish was not accepted', true);

    await pollUntil(
      async () => {
        const res = await this.graph<{ status?: { video_status?: string } }>(
          `/${encodeURIComponent(videoId)}`,
          token,
          { params: { fields: 'status' } },
        );
        const status = res.body.status?.video_status;
        if (status === 'error' || status === 'upload_failed')
          throw new PlatformError(
            'facebook',
            'invalid_media',
            `Video processing failed (${status})`,
            false,
          );
        // VideoStatus.video_status: ready | processing | error
        // (https://developers.facebook.com/docs/graph-api/reference/video-status/).
        return status === 'ready' ? res.body : undefined;
      },
      {
        intervalMs: 10_000,
        timeoutMs: 20 * 60_000,
        platform: 'facebook',
        what: 'Facebook video processing',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );
    return {
      platformPostId: videoId,
      // No documented permalink for a Page video id (Video reference fields), so none is guessed.
      platformUrl: null,
      metadata: { uploadSessionId: sessionId },
    };
  }
}
