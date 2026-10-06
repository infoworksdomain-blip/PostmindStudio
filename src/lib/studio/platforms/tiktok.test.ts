import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { fakeVideoSource } from '../../../../test/helpers/fake-video-source';
import {
  classifyFailReason,
  DEFAULT_NEW_TIKTOK_POST_MODE,
  planChunks,
  TIKTOK_DRAFTS_NOTE,
  TIKTOK_DRAFTS_RECONNECT_NOTE,
  TIKTOK_INBOX_NOTE,
  tiktokPostModeOf,
  TikTokPublisher,
} from './tiktok';
import type { PlatformPublisher, PublishRequest } from './interface';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MB = 1024 * 1024;

function publisher(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    tiktok: new TikTokPublisher({
      fetchImpl: fake.fetch,
      sleep: async () => undefined,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    video: fakeVideoSource({ sizeBytes: 3 * MB, durationSec: 20 }),
    text: 'Fresh bread rising #baking',
    caption: 'Fresh bread rising',
    hashtags: ['baking'],
    accessToken: 'tt-token',
    accountId: 'acct-1',
    aiGenerated: true,
    ...overrides,
  };
}

describe('planChunks', () => {
  it('uses a single chunk covering the whole file when under the 5 MB minimum', () => {
    expect(planChunks(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1, ranges: [[0, 3 * MB - 1]] });
  });

  it('uses a single full-size chunk exactly at the 5 MB minimum', () => {
    expect(planChunks(5 * MB)).toEqual({ chunkSize: 5 * MB, count: 1, ranges: [[0, 5 * MB - 1]] });
  });

  it('splits into 10 MB chunks with the last chunk absorbing the remainder', () => {
    const size = 25 * MB;
    expect(planChunks(size)).toEqual({
      chunkSize: 10 * MB,
      count: 2,
      ranges: [
        [0, 10 * MB - 1],
        [10 * MB, size - 1],
      ],
    });
  });

  it('uses one full-size chunk when between the minimum and the default chunk size', () => {
    expect(planChunks(7 * MB)).toEqual({ chunkSize: 7 * MB, count: 1, ranges: [[0, 7 * MB - 1]] });
  });
});

describe('classifyFailReason', () => {
  it.each([
    [undefined, 'unavailable', true],
    ['internal', 'unavailable', true],
    ['video_pull_failed', 'unavailable', true],
    ['frame_check_failed', 'invalid_media', false],
    ['auth_removed', 'needs_reconnect', false],
    ['spam_risk_too_many_posts', 'content_policy', false],
    ['spam_risk_user_banned_from_posting', 'content_policy', false],
    ['something_unmapped', 'unknown', false],
  ])('%s -> %s (retryable=%s)', (reason, errorClass, retryable) => {
    expect(classifyFailReason(reason)).toEqual({ errorClass, retryable });
  });
});

describe('TikTokPublisher.publish', () => {
  it('sends the full request sequence and returns the publicly available post id', async () => {
    const { tiktok, requests } = publisher(
      json({
        data: {
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
          creator_username: 'demo_creator',
        },
      }),
      json({ data: { publish_id: 'pub-1', upload_url: 'https://upload.tiktok.example/1' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PROCESSING_UPLOAD' } }),
      json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [12345] } }),
    );

    const result = await tiktok.publish(request());

    expect(requests).toHaveLength(5);
    expect(requests[0]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      method: 'POST',
      headers: {
        authorization: 'Bearer tt-token',
        'content-type': 'application/json; charset=UTF-8',
      },
      body: {},
    });
    expect(requests[1]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
      method: 'POST',
      body: {
        post_info: {
          title: 'Fresh bread rising #baking',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          is_aigc: true,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 3 * MB,
          chunk_size: 3 * MB,
          total_chunk_count: 1,
        },
      },
    });
    expect(requests[2]).toMatchObject({
      url: 'https://upload.tiktok.example/1',
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(3 * MB),
        'content-range': `bytes 0-${3 * MB - 1}/${3 * MB}`,
      },
    });
    expect(requests[3]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      body: { publish_id: 'pub-1' },
    });
    expect(requests[4]).toMatchObject({ body: { publish_id: 'pub-1' } });

    expect(result).toEqual({
      platformPostId: '12345',
      platformUrl: null,
      metadata: {
        publishId: 'pub-1',
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        creatorUsername: 'demo_creator',
        publiclyAvailable: true,
        tiktokMode: 'direct',
      },
    });
  });

  it('falls back to the publish id when TikTok reports no public post id (private post)', async () => {
    const { tiktok } = publisher(
      json({ data: { privacy_level_options: ['SELF_ONLY'] } }),
      json({ data: { publish_id: 'pub-2', upload_url: 'https://upload.tiktok.example/2' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PUBLISH_COMPLETE' } }),
    );

    const result = await tiktok.publish(request());

    expect(result.platformPostId).toBe('pub-2');
    expect(result.metadata).toMatchObject({ publiclyAvailable: false, privacyLevel: 'SELF_ONLY' });
  });

  it('uploads in multiple chunks for a file above the chunk size', async () => {
    const size = 25 * MB;
    const { tiktok, requests } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } }),
      json({ data: { publish_id: 'pub-3', upload_url: 'https://upload.tiktok.example/3' } }),
      new Response(null, { status: 206 }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PUBLISH_COMPLETE' } }),
    );

    await tiktok.publish(request({ video: fakeVideoSource({ sizeBytes: size }) }));

    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.headers['content-range'])).toEqual([
      `bytes 0-${10 * MB - 1}/${size}`,
      `bytes ${10 * MB}-${size - 1}/${size}`,
    ]);
  });

  it('honours an explicit privacyLevel option when TikTok supports it', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR'] } }),
      json({ data: { publish_id: 'pub-4', upload_url: 'https://upload.tiktok.example/4' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PUBLISH_COMPLETE' } }),
    );

    await tiktok.publish(request({ options: { privacyLevel: 'FOLLOWER_OF_CREATOR' } }));

    expect(requests[1]?.body).toMatchObject({
      post_info: { privacy_level: 'FOLLOWER_OF_CREATOR' },
    });
  });

  it('rejects before uploading when the video exceeds the creator max duration', async () => {
    const { tiktok, requests } = publisher(
      json({
        data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 60 },
      }),
    );

    await expect(
      tiktok.publish(request({ video: fakeVideoSource({ sizeBytes: MB, durationSec: 90 }) })),
    ).rejects.toMatchObject({ errorClass: 'invalid_media', retryable: false });
    expect(requests).toHaveLength(1);
  });

  it('rejects when TikTok returns no usable privacy level option', async () => {
    const { tiktok, requests } = publisher(json({ data: { privacy_level_options: [] } }));

    // Without video.upload there is no inbox fallback either.
    await expect(
      tiktok.publish(request({ grantedScopes: ['user.info.basic', 'video.publish'] })),
    ).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
    });
    expect(requests).toHaveLength(1);
  });

  it('rejects when init returns no publish_id or upload_url', async () => {
    const { tiktok } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } }),
      json({ data: {} }),
    );

    await expect(tiktok.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('maps a FAILED status into a classified PlatformError', async () => {
    const { tiktok } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } }),
      json({ data: { publish_id: 'pub-5', upload_url: 'https://upload.tiktok.example/5' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'FAILED', fail_reason: 'video_frame_check_failed' } }),
    );

    await expect(tiktok.publish(request())).rejects.toMatchObject({
      errorClass: 'invalid_media',
      retryable: false,
      message: expect.stringContaining('video_frame_check_failed'),
    });
  });

  it.each([
    [401, undefined, 'needs_reconnect', false],
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [500, undefined, 'unavailable', true],
  ])('classifies HTTP %i (code=%s) as %s', async (status, code, errorClass, retryable) => {
    const { tiktok } = publisher(json({ error: { code, message: 'nope' } }, status));

    await expect(tiktok.publish(request())).rejects.toMatchObject({ errorClass, retryable });
  });

  it('classifies a mapped platform error code regardless of HTTP status', async () => {
    const { tiktok } = publisher(
      json({ error: { code: 'spam_risk_user_banned_from_posting', message: 'banned' } }, 400),
    );

    await expect(tiktok.publish(request())).rejects.toMatchObject({
      errorClass: 'content_policy',
      retryable: false,
    });
  });

  it('has no takedown support', () => {
    const { tiktok } = publisher();
    const asPublisher: PlatformPublisher = tiktok;
    expect(asPublisher.takedown).toBeUndefined();
  });
});

describe('TikTokPublisher inbox upload (15.A2)', () => {
  it('picks inbox mode only when video.upload is granted without video.publish', () => {
    expect(TikTokPublisher.modeFor(undefined)).toBe('direct');
    expect(TikTokPublisher.modeFor(['video.publish', 'video.upload'])).toBe('direct');
    expect(TikTokPublisher.modeFor(['video.upload'])).toBe('inbox');
    expect(TikTokPublisher.modeFor(['user.info.basic'])).toBe('direct');
  });

  it('uploads to the inbox when the connection lacks video.publish', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { publish_id: 'inbox-1', upload_url: 'https://upload.tiktok.example/i' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PROCESSING_UPLOAD' } }),
      json({ data: { status: 'SEND_TO_USER_INBOX' } }),
    );

    const result = await tiktok.publish(request({ grantedScopes: ['video.upload'] }));

    expect(requests[0]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      body: {
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 3 * MB,
          chunk_size: 3 * MB,
          total_chunk_count: 1,
        },
      },
    });
    expect(requests[0]?.body).not.toHaveProperty('post_info');
    expect(requests[1]).toMatchObject({ method: 'PUT' });
    expect(result).toEqual({
      platformPostId: 'inbox-1',
      platformUrl: null,
      metadata: {
        publishId: 'inbox-1',
        tiktokMode: 'inbox',
        inboxReason: 'scope',
        inboxStatus: 'SEND_TO_USER_INBOX',
        note: TIKTOK_INBOX_NOTE,
      },
    });
    // P6: the inbox API cannot carry is_aigc, so the note asks the creator to keep the label on.
    expect(TIKTOK_INBOX_NOTE).toContain('AI-generated');
  });

  it('falls back to the inbox when the creator has no privacy options', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { privacy_level_options: [] } }),
      json({ data: { publish_id: 'inbox-2', upload_url: 'https://upload.tiktok.example/j' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'SEND_TO_USER_INBOX' } }),
    );

    const result = await tiktok.publish(
      request({ grantedScopes: ['video.publish', 'video.upload'] }),
    );

    expect(requests[1]?.url).toBe('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
    expect(result.metadata).toMatchObject({ tiktokMode: 'inbox', inboxReason: 'privacy_options' });
  });

  it('fails when the inbox upload fails', async () => {
    const { tiktok } = publisher(
      json({ data: { publish_id: 'inbox-3', upload_url: 'https://upload.tiktok.example/k' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'FAILED', fail_reason: 'frame_check_failed' } }),
    );

    await expect(
      tiktok.publish(request({ grantedScopes: ['video.upload'] })),
    ).rejects.toMatchObject({
      errorClass: 'invalid_media',
    });
  });
});

describe('TikTokPublisher drafts (22.7)', () => {
  const BOTH = ['user.info.basic', 'video.publish', 'video.upload'];

  it('reads the stored preference: only "drafts" sends drafts, null and anything else post directly', () => {
    expect(tiktokPostModeOf('drafts')).toBe('drafts');
    expect(tiktokPostModeOf('direct')).toBe('direct');
    expect(tiktokPostModeOf(null)).toBe('direct');
    expect(tiktokPostModeOf(undefined)).toBe('direct');
    expect(DEFAULT_NEW_TIKTOK_POST_MODE).toBe('drafts');
  });

  it('plans drafts only when video.upload is granted (unknown scopes are tried)', () => {
    expect(TikTokPublisher.planFor({ grantedScopes: BOTH, tiktokPostMode: 'drafts' })).toEqual({
      mode: 'inbox',
      reason: 'drafts',
      draftsUnavailable: false,
    });
    expect(TikTokPublisher.planFor({ tiktokPostMode: 'drafts' })).toMatchObject({
      mode: 'inbox',
      reason: 'drafts',
    });
    expect(
      TikTokPublisher.planFor({ grantedScopes: ['video.publish'], tiktokPostMode: 'drafts' }),
    ).toEqual({ mode: 'direct', draftsUnavailable: true });
    expect(TikTokPublisher.planFor({ grantedScopes: BOTH, tiktokPostMode: 'direct' })).toEqual({
      mode: 'direct',
      draftsUnavailable: false,
    });
    expect(TikTokPublisher.planFor({ grantedScopes: BOTH })).toEqual({
      mode: 'direct',
      draftsUnavailable: false,
    });
  });

  it('sends a draft video with the documented inbox init (source_info only) even with video.publish', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { publish_id: 'draft-1', upload_url: 'https://upload.tiktok.example/d' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'SEND_TO_USER_INBOX' } }),
    );

    const result = await tiktok.publish(request({ grantedScopes: BOTH, tiktokPostMode: 'drafts' }));

    // No creator_info / direct init: the first call is the inbox init.
    expect(requests[0]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',
      method: 'POST',
      body: {
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 3 * MB,
          chunk_size: 3 * MB,
          total_chunk_count: 1,
        },
      },
    });
    expect(Object.keys(requests[0]?.body as object)).toEqual(['source_info']);
    expect(requests.some((r) => r.url.endsWith('/video/init/') && !r.url.includes('inbox'))).toBe(
      false,
    );
    expect(result).toEqual({
      platformPostId: 'draft-1',
      platformUrl: null,
      metadata: {
        publishId: 'draft-1',
        tiktokMode: 'inbox',
        inboxReason: 'drafts',
        inboxStatus: 'SEND_TO_USER_INBOX',
        note: TIKTOK_DRAFTS_NOTE,
      },
    });
    // The inbox init cannot set is_aigc: the note keeps the AI-label reminder.
    expect(TIKTOK_DRAFTS_NOTE).toContain('"AI-generated content" label switched on');
    expect(TIKTOK_DRAFTS_NOTE).toContain('trending sound');
  });

  it('posts directly and says "Reconnect TikTok to send drafts" when video.upload is missing', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } }),
      json({ data: { publish_id: 'pub-d', upload_url: 'https://upload.tiktok.example/x' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [77] } }),
    );

    const result = await tiktok.publish(
      request({ grantedScopes: ['user.info.basic', 'video.publish'], tiktokPostMode: 'drafts' }),
    );

    expect(requests[1]?.url).toBe('https://open.tiktokapis.com/v2/post/publish/video/init/');
    expect(result.metadata).toMatchObject({
      tiktokMode: 'direct',
      draftsUnavailable: 'missing_scope',
      draftsNote: TIKTOK_DRAFTS_RECONNECT_NOTE,
    });
    expect(TIKTOK_DRAFTS_RECONNECT_NOTE).toMatch(/^Reconnect TikTok to send drafts/);
  });

  it('keeps direct posting for connections that chose (or default to) direct', async () => {
    const { tiktok, requests } = publisher(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] } }),
      json({ data: { publish_id: 'pub-e', upload_url: 'https://upload.tiktok.example/y' } }),
      new Response(null, { status: 201 }),
      json({ data: { status: 'PUBLISH_COMPLETE' } }),
    );

    const result = await tiktok.publish(request({ grantedScopes: BOTH, tiktokPostMode: 'direct' }));

    expect(requests[0]?.url).toContain('/creator_info/query/');
    expect(result.metadata).toMatchObject({ tiktokMode: 'direct' });
    expect(result.metadata).not.toHaveProperty('draftsUnavailable');
  });
});
