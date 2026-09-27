import { PlatformError } from '../../errors';
import { asBody, platformRequest, pollUntil } from './http';
import type {
  PlatformPublisher,
  PublishRequest,
  PublishResult,
  PublisherDeps,
  TakedownRequest,
} from './interface';

// BACKLOG 5.5 — X API v2 (spec 9.5). The spec's v1.1 upload.twitter.com INIT/APPEND/FINALIZE flow
// is gone; the v2 media endpoints replace it. Contract (docs.x.com, read 2026-09-27):
//   POST https://api.x.com/2/media/upload/initialize  JSON {media_type, total_bytes, media_category=tweet_video}
//        → data.id
//   POST /2/media/upload/{id}/append  multipart {segment_index, media}; segments ≤5 MB
//   POST /2/media/upload/{id}/finalize → data.processing_info? {state, check_after_secs}
//   GET  /2/media/upload?command=STATUS&media_id={id} → processing_info.state pending|in_progress|succeeded|failed
//   POST /2/tweets {text, media:{media_ids:[id]}} → 201 data.id
// No post URL format is documented, so platformUrl stays null.

export const API = 'https://api.x.com';
export const SEGMENT_BYTES = 5 * 1024 * 1024;

interface ProcessingInfo {
  state?: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  check_after_secs?: number;
}

function describe(body: unknown) {
  const b = body as
    | { detail?: string; title?: string; errors?: Array<{ message?: string; code?: number }> }
    | undefined;
  const code = b?.errors?.[0]?.code;
  return {
    message: b?.detail ?? b?.title ?? b?.errors?.[0]?.message,
    code: code === undefined ? undefined : String(code),
  };
}

export class XPublisher implements PlatformPublisher {
  readonly platform = 'x' as const;

  constructor(private readonly deps: PublisherDeps) {}

  private opts(timeoutMs?: number) {
    return { platform: 'x', fetchImpl: this.deps.fetchImpl, describe, timeoutMs };
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const auth = { authorization: `Bearer ${request.accessToken}` };
    const init = await platformRequest<{ data?: { id?: string } }>(
      `${API}/2/media/upload/initialize`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          media_type: request.video.contentType,
          total_bytes: request.video.sizeBytes,
          media_category: 'tweet_video',
        }),
      },
      this.opts(),
    );
    const mediaId = init.body.data?.id;
    if (!mediaId) throw new PlatformError('x', 'unknown', 'Media initialize returned no id', true);

    for (
      let index = 0, offset = 0;
      offset < request.video.sizeBytes;
      index += 1, offset += SEGMENT_BYTES
    ) {
      const end = Math.min(offset + SEGMENT_BYTES, request.video.sizeBytes) - 1;
      const bytes = await request.video.read(offset, end);
      const form = new FormData();
      form.append('segment_index', String(index));
      form.append(
        'media',
        new Blob([asBody(bytes)], { type: request.video.contentType }),
        'video.mp4',
      );
      await platformRequest<unknown>(
        `${API}/2/media/upload/${encodeURIComponent(mediaId)}/append`,
        { method: 'POST', headers: auth, body: form },
        this.opts(5 * 60_000),
      );
    }

    const finalized = await platformRequest<{ data?: { processing_info?: ProcessingInfo } }>(
      `${API}/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
      { method: 'POST', headers: auth },
      this.opts(),
    );
    let info = finalized.body.data?.processing_info;
    if (info) {
      let waitMs = Math.max(1, info.check_after_secs ?? 5) * 1000;
      info = await pollUntil(
        async () => {
          const res = await platformRequest<{ data?: { processing_info?: ProcessingInfo } }>(
            `${API}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
            { headers: auth },
            this.opts(),
          );
          const current = res.body.data?.processing_info;
          if (current?.state === 'failed')
            throw new PlatformError('x', 'invalid_media', 'X media processing failed', false);
          if (current?.check_after_secs) waitMs = current.check_after_secs * 1000;
          return !current || current.state === 'succeeded'
            ? (current ?? { state: 'succeeded' })
            : undefined;
        },
        {
          intervalMs: waitMs,
          timeoutMs: 10 * 60_000,
          platform: 'x',
          what: 'X media processing',
          sleep: this.deps.sleep,
          now: this.deps.now,
        },
      );
    }

    const tweet = await platformRequest<{ data?: { id?: string } }>(
      `${API}/2/tweets`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ text: request.text, media: { media_ids: [mediaId] } }),
      },
      this.opts(),
    );
    const postId = tweet.body.data?.id;
    if (!postId) throw new PlatformError('x', 'unknown', 'Create post returned no id', true);
    return {
      platformPostId: postId,
      platformUrl: null,
      metadata: { mediaId, processing: info?.state ?? 'none' },
    };
  }

  /** DELETE /2/tweets/{id} → data.deleted. */
  async takedown(request: TakedownRequest): Promise<void> {
    const res = await platformRequest<{ data?: { deleted?: boolean } }>(
      `${API}/2/tweets/${encodeURIComponent(request.platformPostId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${request.accessToken}` } },
      this.opts(),
    );
    if (res.body.data?.deleted !== true) {
      throw new PlatformError('x', 'unknown', 'X did not confirm deletion', true);
    }
  }
}
