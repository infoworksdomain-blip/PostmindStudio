import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import {
  DEFAULT_GRAPH_VERSION,
  FacebookFeedPublisher,
  FacebookReelPublisher,
  GRAPH_HOST,
  GRAPH_VIDEO_HOST,
  InstagramReelPublisher,
  RUPLOAD_HOST,
} from './meta';
import type { PublishRequest } from './interface';

function deps(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => 0),
  };
}

function baseRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    video: {
      sizeBytes: 100,
      contentType: 'video/mp4',
      durationSec: 10,
      aspectRatio: '9:16',
      signedUrl: 'https://signed.example/video.mp4',
      read: vi.fn(async () => new Uint8Array()),
    },
    text: 'caption text',
    caption: 'caption text',
    hashtags: [],
    accessToken: 'token-1',
    accountId: 'account-1',
    aiGenerated: true,
    ...overrides,
  };
}

describe('InstagramReelPublisher', () => {
  it('creates a container, polls until FINISHED, publishes, and fetches the permalink', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ id: 'container-1' }),
      json({ status_code: 'IN_PROGRESS', status: 'in progress' }),
      json({ status_code: 'FINISHED', status: 'ok' }),
      json({ id: 'media-1' }),
      json({ permalink: 'https://instagram.com/p/abc', shortcode: 'abc', timestamp: '2026-01-01' }),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    const result = await publisher.publish(baseRequest());

    expect(result).toEqual({
      platformPostId: 'media-1',
      platformUrl: 'https://instagram.com/p/abc',
      metadata: { containerId: 'container-1', shortcode: 'abc', timestamp: '2026-01-01' },
    });
    expect(requests[0]?.url).toBe(`${GRAPH_HOST}/${DEFAULT_GRAPH_VERSION}/account-1/media`);
    expect(requests[0]?.method).toBe('POST');
    const createBody = requests[0]?.body as URLSearchParams;
    expect(createBody.get('media_type')).toBe('REELS');
    expect(createBody.get('video_url')).toBe('https://signed.example/video.mp4');
    expect(createBody.get('share_to_feed')).toBe('true');
    expect(createBody.get('is_ai_generated')).toBe('true');
    expect(createBody.get('access_token')).toBe('token-1');
    // Status polls are GET requests with query params, not POST bodies.
    expect(requests[1]?.method).toBe('GET');
    expect(requests[1]?.url).toContain('fields=status_code%2Cstatus');
    expect(requests[3]?.url).toBe(`${GRAPH_HOST}/${DEFAULT_GRAPH_VERSION}/account-1/media_publish`);
  });

  it('throws when container creation returns no id', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({}));
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('throws a non-retryable PlatformError when the container status is ERROR', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ id: 'container-1' }),
      json({ status_code: 'ERROR', status: 'bad media' }),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'invalid_media',
      retryable: false,
    });
  });

  it('throws a retryable PlatformError when the container EXPIREs', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ id: 'container-1' }),
      json({ status_code: 'EXPIRED' }),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'unavailable',
      retryable: true,
    });
  });

  it('throws when publish returns no media id', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ id: 'container-1' }),
      json({ status_code: 'FINISHED' }),
      json({}),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'unknown',
    });
  });

  it('classifies a token-expired Graph error (subcode 190) as needs_reconnect', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ error: { message: 'Session expired', code: 190 } }, 400),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'needs_reconnect',
      retryable: false,
    });
  });

  it('classifies code 190 as needs_reconnect even when Meta sends a subcode (463 expired)', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
  });

  it('classifies a known IG subcode error (spam) as content_policy, non-retryable', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ error: { message: 'Spam', error_subcode: 2207051 } }, 400),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'content_policy',
      retryable: false,
    });
  });

  it('classifies rate-limit codes (4, 17, 32, 613) as rate_limited, retryable', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ error: { message: 'Too many calls', code: 4 } }, 400),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'rate_limited',
      retryable: true,
    });
  });

  it('performs takedown via DELETE with the platform post id', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ success: true }));
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await publisher.takedown({ accessToken: 'tok', accountId: 'acc', platformPostId: 'media-9' });
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toContain('/media-9');
  });

  it('falls back to the default HTTP-status classification for an unrecognised Graph code', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({ error: { message: 'Odd', code: 999999 } }, 400));
    const publisher = new InstagramReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'instagram',
      errorClass: 'invalid_request',
      retryable: false,
    });
  });
});

describe('FacebookReelPublisher', () => {
  it('runs start → rupload → finish → poll → permalink lookup', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ video_id: 'video-1' }), // start
      json({ success: true }), // rupload
      json({ success: true, post_id: 'post-1' }), // finish
      json({
        status: { video_status: 'processing', publishing_phase: { publish_status: 'in_progress' } },
      }),
      json({
        status: { video_status: 'ready', publishing_phase: { publish_status: 'published' } },
      }),
      json({ permalink_url: 'https://facebook.com/1/videos/1' }),
    );
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    const result = await publisher.publish(baseRequest());

    expect(result).toEqual({
      platformPostId: 'video-1',
      platformUrl: 'https://facebook.com/1/videos/1',
      metadata: { postId: 'post-1' },
    });
    expect(requests[0]?.url).toBe(`${GRAPH_HOST}/${DEFAULT_GRAPH_VERSION}/account-1/video_reels`);
    expect(requests[1]?.url).toBe(`${RUPLOAD_HOST}/video-upload/${DEFAULT_GRAPH_VERSION}/video-1`);
    expect(requests[1]?.headers.authorization).toBe('OAuth token-1');
    expect(requests[1]?.headers.file_url).toBe('https://signed.example/video.mp4');
  });

  it('throws when start returns no video_id', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({}));
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'facebook',
      errorClass: 'unknown',
    });
  });

  it('throws a non-retryable PlatformError when reel processing errors', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ video_id: 'video-1' }),
      json({ success: true }),
      json({ success: true, post_id: 'post-1' }),
      json({ status: { video_status: 'error' } }),
    );
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'facebook',
      errorClass: 'invalid_media',
      retryable: false,
    });
  });

  it('throws a retryable PlatformError when the reel upload expires', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ video_id: 'video-1' }),
      json({ success: true }),
      json({ success: true, post_id: 'post-1' }),
      json({ status: { video_status: 'expired' } }),
    );
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    await expect(publisher.publish(baseRequest())).rejects.toMatchObject({
      platform: 'facebook',
      errorClass: 'unavailable',
      retryable: true,
    });
  });

  it('skips the permalink lookup when finish returns no post_id', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ video_id: 'video-1' }),
      json({ success: true }),
      json({ success: true }), // no post_id
      json({ status: { publishing_phase: { publish_status: 'published' } } }),
    );
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    const result = await publisher.publish(baseRequest());
    expect(result.platformUrl).toBeNull();
    expect(result.metadata).toEqual({ postId: null });
    expect(requests).toHaveLength(4);
  });

  it('performs takedown via DELETE with the platform post id', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(json({ success: true }));
    const publisher = new FacebookReelPublisher(deps(fetchImpl));
    await publisher.takedown({ accessToken: 'tok', accountId: 'acc', platformPostId: 'video-9' });
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toContain('/video-9');
  });
});

describe('Instagram feed video (15.A1)', () => {
  it('publishes a REELS container shared to the feed, AI label on', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ id: 'container-f' }),
      json({ status_code: 'FINISHED' }),
      json({ id: 'media-f' }),
      json({ permalink: 'https://instagram.com/p/feed' }),
    );
    const publisher = new InstagramReelPublisher(deps(fetchImpl), 'instagram_feed');
    expect(publisher.platform).toBe('instagram_feed');
    const result = await publisher.publish(
      baseRequest({ video: { ...baseRequest().video, aspectRatio: '4:5' } }),
    );
    const body = requests[0]?.body as URLSearchParams;
    expect(body.get('media_type')).toBe('REELS');
    expect(body.get('share_to_feed')).toBe('true');
    expect(body.get('is_ai_generated')).toBe('true');
    expect(result.platformPostId).toBe('media-f');
  });
});

describe('FacebookFeedPublisher (15.A1)', () => {
  function video(size: number) {
    const bytes = new Uint8Array(size).fill(7);
    return {
      sizeBytes: size,
      contentType: 'video/mp4' as const,
      durationSec: 30,
      aspectRatio: '16:9' as const,
      signedUrl: 'https://signed.example/feed.mp4',
      read: vi.fn(async (s: number, e: number) => bytes.slice(s, e + 1)),
    };
  }

  it('runs upload_phase start, transfer (per window), finish, then polls status', async () => {
    const { fetch: fetchImpl, requests } = fakeFetch(
      json({ upload_session_id: 'sess-1', video_id: 'vid-1', start_offset: '0', end_offset: '60' }),
      json({ start_offset: '60', end_offset: '100' }),
      json({ start_offset: '100', end_offset: '100' }),
      json({ success: true }),
      json({ status: { video_status: 'processing' } }),
      json({ status: { video_status: 'ready' } }),
    );
    const v = video(100);
    const result = await new FacebookFeedPublisher(deps(fetchImpl)).publish(
      baseRequest({ video: v, title: 'Feed title' }),
    );

    const url = `${GRAPH_VIDEO_HOST}/${DEFAULT_GRAPH_VERSION}/account-1/videos`;
    expect(requests[0]?.url).toBe(url);
    const start = requests[0]?.body as URLSearchParams;
    expect(start.get('upload_phase')).toBe('start');
    expect(start.get('file_size')).toBe('100');
    expect(start.get('access_token')).toBe('token-1');
    const transfer = requests[1]?.body as FormData;
    expect(transfer.get('upload_phase')).toBe('transfer');
    expect(transfer.get('upload_session_id')).toBe('sess-1');
    expect(transfer.get('start_offset')).toBe('0');
    expect((transfer.get('video_file_chunk') as Blob).size).toBe(60);
    expect((requests[2]?.body as FormData).get('start_offset')).toBe('60');
    expect(v.read).toHaveBeenNthCalledWith(2, 60, 99);
    const finish = requests[3]?.body as URLSearchParams;
    expect(finish.get('upload_phase')).toBe('finish');
    expect(finish.get('description')).toBe('caption text');
    expect(finish.get('title')).toBe('Feed title');
    expect(requests[4]?.url).toContain('/vid-1?');
    expect(result).toEqual({
      platformPostId: 'vid-1',
      platformUrl: null,
      metadata: { uploadSessionId: 'sess-1' },
    });
  });

  it('throws when start returns no session', async () => {
    const { fetch: fetchImpl } = fakeFetch(json({}));
    await expect(
      new FacebookFeedPublisher(deps(fetchImpl)).publish(baseRequest({ video: video(10) })),
    ).rejects.toMatchObject({ errorClass: 'unknown', retryable: true });
  });

  it('fails non-retryably when processing reports error', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ upload_session_id: 's', video_id: 'v', start_offset: '0', end_offset: '0' }),
      json({ success: true }),
      json({ status: { video_status: 'error' } }),
    );
    await expect(
      new FacebookFeedPublisher(deps(fetchImpl)).publish(baseRequest({ video: video(10) })),
    ).rejects.toMatchObject({ errorClass: 'invalid_media', retryable: false });
  });

  it('refuses when finish is not accepted', async () => {
    const { fetch: fetchImpl } = fakeFetch(
      json({ upload_session_id: 's', video_id: 'v', start_offset: '0', end_offset: '0' }),
      json({ success: false }),
    );
    await expect(
      new FacebookFeedPublisher(deps(fetchImpl)).publish(baseRequest({ video: video(10) })),
    ).rejects.toMatchObject({ errorClass: 'unknown' });
  });
});
