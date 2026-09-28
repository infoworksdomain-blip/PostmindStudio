import { PlatformError } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type {
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  PublisherDeps,
  TakedownRequest,
} from './interface';

// BACKLOG 5.4 — YouTube Data API v3 resumable upload (spec 9.4), Shorts and long-form.
// Contract (developers.google.com/youtube, read 2026-09-27):
//   POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status
//        headers X-Upload-Content-Length / X-Upload-Content-Type; body = video resource
//        → 200 + Location (session URI)
//   PUT  session  Content-Range: bytes first-last/total; non-final chunks = same size, multiple of
//        256 KiB; 308 = continue (Range: bytes=0-N); 200/201 = video resource; 404 = session expired
//   GET  https://www.googleapis.com/youtube/v3/videos?part=status&id=…  (uploadStatus)
// Quota (2026-06 bucket model): videos.insert costs 1 unit of the "Video Uploads" bucket.
// 15.A3 / 15.A4 (read 2026-09-28):
//   POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=  body = the image
//        (image/jpeg | image/png, ≤50 MB; ~50 units)
//        https://developers.google.com/youtube/v3/docs/thumbnails/set
//   POST https://www.googleapis.com/upload/youtube/v3/captions?part=snippet  caption resource
//        {snippet: {videoId, language, name}} + the track (400 units; youtube.force-ssl, which
//        Studio's OAuth requests), sent as a Google multipart media upload (uploadType=multipart:
//        multipart/related, JSON metadata part then the media part)
//        https://developers.google.com/youtube/v3/docs/captions/insert
//   Both run after the video is live, so a failure is recorded on the publication, never
//   turned into a failed publish (the video would be uploaded twice on retry).
// Unverified API projects' uploads are forced private until the project passes an audit.

export const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
export const THUMBNAIL_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
export const CAPTIONS_URL = 'https://www.googleapis.com/upload/youtube/v3/captions';
export const API = 'https://www.googleapis.com/youtube/v3';
export const CHUNK_SIZE = 32 * 256 * 1024; // 8 MiB, a multiple of 256 KiB
const DEFAULT_CATEGORY_ID = '22'; // spec 9.4: "People & Blogs"
const STATUS_POLL_MS = 10_000;
const STATUS_TIMEOUT_MS = 5 * 60_000;

interface YouTubeError {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

function describe(body: unknown) {
  const err = (body as YouTubeError | undefined)?.error;
  const reason = err?.errors?.[0]?.reason;
  return { message: err?.message ? `${reason ?? err.code}: ${err.message}` : reason, code: reason };
}

function refine(_status: number, reason: string | undefined) {
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded')
    return { errorClass: 'quota_exceeded' as const, retryable: false };
  if (reason === 'rateLimitExceeded')
    return { errorClass: 'rate_limited' as const, retryable: true };
  return undefined;
}

export class YouTubePublisher implements PlatformPublisher {
  constructor(
    readonly platform: 'youtube' | 'youtube_short',
    private readonly deps: PublisherDeps,
  ) {}

  private opts(timeoutMs?: number) {
    return { platform: 'youtube', fetchImpl: this.deps.fetchImpl, describe, refine, timeoutMs };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const { video } = request;
    const auth = { authorization: `Bearer ${request.accessToken}` };
    const privacyStatus =
      typeof request.options?.privacyStatus === 'string' ? request.options.privacyStatus : 'public';
    const metadata = {
      snippet: {
        title: request.title ?? 'Untitled',
        description: request.text,
        categoryId: DEFAULT_CATEGORY_ID,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: request.aiGenerated,
      },
    };

    const session = await platformRequest<unknown>(
      `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(video.sizeBytes),
          'x-upload-content-type': video.contentType,
        },
        body: JSON.stringify(metadata),
      },
      this.opts(),
    );
    const sessionUrl = session.headers.get('location');
    if (!sessionUrl)
      throw new PlatformError(
        'youtube',
        'unknown',
        'Resumable upload returned no session URL',
        true,
      );

    let offset = 0;
    let uploaded: { id?: string } | undefined;
    while (offset < video.sizeBytes) {
      const end = Math.min(offset + CHUNK_SIZE, video.sizeBytes) - 1;
      const bytes = await video.read(offset, end);
      const res = await platformRequest<{ id?: string }>(
        sessionUrl,
        {
          method: 'PUT',
          headers: {
            ...auth,
            'content-length': String(bytes.byteLength),
            'content-range': `bytes ${offset}-${end}/${video.sizeBytes}`,
          },
          body: asBody(bytes),
        },
        this.opts(5 * 60_000),
      );
      if (res.status === 308) {
        // Range: bytes=0-N tells how much YouTube has; continue from N+1.
        const range = res.headers.get('range');
        const received = range ? Number(range.split('-')[1]) : NaN;
        offset = Number.isFinite(received) ? received + 1 : end + 1;
        continue;
      }
      uploaded = res.body;
      break;
    }
    const videoId = uploaded?.id;
    if (!videoId)
      throw new PlatformError('youtube', 'unknown', 'Upload finished without a video id', true);

    const status = await pollUntil(
      async () => {
        const res = await platformRequest<{
          items?: Array<{
            status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string };
          }>;
        }>(
          `${API}/videos?part=status&id=${encodeURIComponent(videoId)}`,
          { headers: auth },
          this.opts(),
        );
        const s = res.body.items?.[0]?.status;
        if (s?.uploadStatus === 'failed') {
          throw new PlatformError(
            'youtube',
            'invalid_media',
            `YouTube processing failed: ${s.failureReason ?? 'unknown'}`,
            false,
          );
        }
        if (s?.uploadStatus === 'rejected') {
          throw new PlatformError(
            'youtube',
            'content_policy',
            `YouTube rejected the video: ${s.rejectionReason ?? 'unknown'}`,
            false,
          );
        }
        return s?.uploadStatus === 'processed' || s?.uploadStatus === 'uploaded' ? s : undefined;
      },
      {
        intervalMs: STATUS_POLL_MS,
        timeoutMs: STATUS_TIMEOUT_MS,
        platform: 'youtube',
        what: 'YouTube processing',
        sleep: this.deps.sleep,
        now: this.deps.now,
      },
    );

    const extras = await this.afterUpload(videoId, request);
    return {
      platformPostId: videoId,
      // The Data API documents no watch-URL format (only an example inside the push-notification
      // feed), so the video id is stored and the URL is left to the client.
      platformUrl: null,
      metadata: {
        uploadStatus: status.uploadStatus,
        privacyStatus,
        shorts: this.platform === 'youtube_short',
        ...extras,
      },
    };
  }

  /** thumbnails.set + captions.insert; each outcome is reported, never thrown (video is live). */
  private async afterUpload(
    videoId: string,
    request: PublishRequest,
  ): Promise<Record<string, unknown>> {
    const auth = { authorization: `Bearer ${request.accessToken}` };
    const out: Record<string, unknown> = {};
    if (request.thumbnail) {
      try {
        await platformRequest<unknown>(
          `${THUMBNAIL_URL}?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': request.thumbnail.contentType },
            body: asBody(request.thumbnail.bytes),
          },
          this.opts(),
        );
        out.thumbnail = 'set';
      } catch (err) {
        out.thumbnail = 'failed';
        out.thumbnailError = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
      }
    }
    if (request.captions) {
      try {
        const boundary = `studio-captions-${videoId}`;
        const meta = JSON.stringify({
          snippet: {
            videoId,
            language: request.captions.language,
            name: request.captions.name,
            isDraft: false,
          },
        });
        const body = [
          `--${boundary}`,
          'Content-Type: application/json; charset=UTF-8',
          '',
          meta,
          `--${boundary}`,
          'Content-Type: application/octet-stream',
          '',
          request.captions.srt,
          `--${boundary}--`,
          '',
        ].join('\r\n');
        const res = await platformRequest<{ id?: string }>(
          `${CAPTIONS_URL}?uploadType=multipart&part=snippet`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': `multipart/related; boundary=${boundary}` },
            body,
          },
          this.opts(),
        );
        out.captions = 'uploaded';
        out.captionTrackId = res.body.id ?? null;
      } catch (err) {
        out.captions = 'failed';
        out.captionsError = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
      }
    }
    return out;
  }

  /** videos.delete: DELETE /youtube/v3/videos?id= → 204 (50 quota units; youtube.force-ssl). */
  async takedown(request: TakedownRequest): Promise<void> {
    await platformRequest<unknown>(
      `${API}/videos?id=${encodeURIComponent(request.platformPostId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${request.accessToken}` } },
      this.opts(),
    );
  }
}
