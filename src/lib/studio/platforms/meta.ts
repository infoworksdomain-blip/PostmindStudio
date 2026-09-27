import { PlatformError, type PlatformErrorClass } from '../../errors';
import { platformRequest, pollUntil } from './http';
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
// Tokens: PostMind Core pushes them to /api/studio/internal/channels (see MetaCredentialSource).

export const GRAPH_HOST = 'https://graph.facebook.com';
export const RUPLOAD_HOST = 'https://rupload.facebook.com';
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
  abstract readonly platform: 'instagram_reel' | 'facebook';
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
        platform: this.platform === 'facebook' ? 'facebook' : 'instagram',
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
  readonly platform = 'instagram_reel' as const;

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
