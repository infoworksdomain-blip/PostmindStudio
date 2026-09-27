import { PlatformError } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type {
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  PublisherDeps,
  TakedownRequest,
} from './interface';

// BACKLOG 5.6 — LinkedIn Videos + Posts API (spec 9.6). Contract (learn.microsoft.com/linkedin,
// versioned API li-lms-2026-09, read 2026-09-27):
//   headers Linkedin-Version: 202609, X-Restli-Protocol-Version: 2.0.0
//   POST /rest/videos?action=initializeUpload {initializeUploadRequest:{owner, fileSizeBytes,
//        uploadCaptions:false, uploadThumbnail:false}} → value{video, uploadToken, uploadInstructions[]}
//   PUT  each uploadUrl (octet-stream, no auth) with bytes firstByte..lastByte; keep each ETag
//   POST /rest/videos?action=finalizeUpload {finalizeUploadRequest:{video, uploadToken, uploadedPartIds}}
//   GET  /rest/videos/{urn} → status WAITING_UPLOAD|PROCESSING|AVAILABLE|PROCESSING_FAILED
//   POST /rest/posts {author, commentary, visibility, distribution, content.media.id, lifecycleState}
//        → 201, header x-restli-id = post URN
// Documented public URL: https://www.linkedin.com/feed/update/urn:li:ugcPost:{id}/ (ugcPost only).

export const API = 'https://api.linkedin.com/rest';
export const LINKEDIN_VERSION = '202609';

function describe(body: unknown) {
  const b = body as { message?: string; serviceErrorCode?: number; code?: string } | undefined;
  return {
    message: b?.message,
    code: b?.code ?? (b?.serviceErrorCode !== undefined ? String(b.serviceErrorCode) : undefined),
  };
}

function refine(status: number, code: string | undefined) {
  if (code === 'CONTENT_BLOCKED')
    return { errorClass: 'content_policy' as const, retryable: false };
  if (status === 403 && code === 'ACCESS_DENIED')
    return { errorClass: 'needs_reconnect' as const, retryable: false };
  return undefined;
}

/**
 * Escape text for the Posts API `commentary` field ("little text format"): every reserved
 * character | { } @ [ ] ( ) < > # \ * _ ~ must be backslash-escaped to appear literally.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/** Commentary = escaped caption + hashtags in the documented {hashtag|\#|tag} template. */
export function buildCommentary(caption: string, hashtags: string[]): string {
  const tags = hashtags.map((tag) => `{hashtag|\\#|${escapeLittleText(tag)}}`).join(' ');
  return [escapeLittleText(caption.trim()), tags].filter(Boolean).join('\n\n');
}

export class LinkedInPublisher implements PlatformPublisher {
  readonly platform = 'linkedin_video' as const;

  constructor(private readonly deps: PublisherDeps) {}

  private rest<T>(path: string, token: string, init: { method?: string; body?: unknown }) {
    return platformRequest<T>(
      `${API}${path}`,
      {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'linkedin-version': LINKEDIN_VERSION,
          'x-restli-protocol-version': '2.0.0',
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      },
      { platform: 'linkedin', fetchImpl: this.deps.fetchImpl, describe, refine },
    );
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = request.accessToken;
    const owner = request.accountId; // urn:li:person:… or urn:li:organization:…
    const init = await this.rest<{
      value?: {
        video?: string;
        uploadToken?: string;
        uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
      };
    }>('/videos?action=initializeUpload', token, {
      method: 'POST',
      body: {
        initializeUploadRequest: {
          owner,
          fileSizeBytes: request.video.sizeBytes,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
    });
    const value = init.body.value;
    if (!value?.video || !value.uploadInstructions?.length) {
      throw new PlatformError(
        'linkedin',
        'unknown',
        'initializeUpload returned no video/instructions',
        true,
      );
    }

    const etags: string[] = [];
    for (const part of value.uploadInstructions) {
      const bytes = await request.video.read(part.firstByte, part.lastByte);
      const res = await platformRequest<unknown>(
        part.uploadUrl,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: asBody(bytes),
        },
        { platform: 'linkedin', fetchImpl: this.deps.fetchImpl, timeoutMs: 5 * 60_000 },
      );
      const etag = res.headers.get('etag');
      if (!etag)
        throw new PlatformError('linkedin', 'unknown', 'Upload part returned no ETag', true);
      etags.push(etag);
    }

    await this.rest<unknown>('/videos?action=finalizeUpload', token, {
      method: 'POST',
      body: {
        finalizeUploadRequest: {
          video: value.video,
          uploadToken: value.uploadToken ?? '',
          uploadedPartIds: etags,
        },
      },
    });

    const videoUrn = value.video;
    await pollUntil(
      async () => {
        const res = await this.rest<{ status?: string; processingFailureReason?: string }>(
          `/videos/${encodeURIComponent(videoUrn)}`,
          token,
          {},
        );
        if (res.body.status === 'PROCESSING_FAILED') {
          throw new PlatformError(
            'linkedin',
            'invalid_media',
            `LinkedIn processing failed: ${res.body.processingFailureReason ?? 'unknown'}`,
            false,
          );
        }
        return res.body.status === 'AVAILABLE' ? res.body.status : undefined;
      },
      {
        intervalMs: 10_000,
        timeoutMs: 15 * 60_000,
        platform: 'linkedin',
        what: 'LinkedIn video processing',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );

    const post = await this.rest<unknown>('/posts', token, {
      method: 'POST',
      body: {
        author: owner,
        commentary: buildCommentary(request.caption, request.hashtags),
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: { media: { title: request.title ?? '', id: videoUrn } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    });
    const postUrn = post.headers.get('x-restli-id');
    if (!postUrn)
      throw new PlatformError('linkedin', 'unknown', 'Post created without x-restli-id', true);
    return {
      platformPostId: postUrn,
      platformUrl: postUrn.startsWith('urn:li:ugcPost:')
        ? `https://www.linkedin.com/feed/update/${postUrn}/`
        : null,
      metadata: { videoUrn },
    };
  }

  /** DELETE /rest/posts/{urn} → 204 (idempotent: an already-deleted post also returns 204). */
  async takedown(request: TakedownRequest): Promise<void> {
    await platformRequest<unknown>(
      `${API}/posts/${encodeURIComponent(request.platformPostId)}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${request.accessToken}`,
          'linkedin-version': LINKEDIN_VERSION,
          'x-restli-protocol-version': '2.0.0',
          'x-restli-method': 'DELETE',
        },
      },
      { platform: 'linkedin', fetchImpl: this.deps.fetchImpl, describe, refine },
    );
  }
}
