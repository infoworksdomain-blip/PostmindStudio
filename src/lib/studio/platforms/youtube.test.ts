import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { fakeVideoSource } from '../../../../test/helpers/fake-video-source';
import { CAPTIONS_URL, CHUNK_SIZE, THUMBNAIL_URL, UPLOAD_URL, YouTubePublisher } from './youtube';
import type { PublishRequest } from './interface';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MB = 1024 * 1024;

function publisher(kind: 'youtube' | 'youtube_short', ...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    youtube: new YouTubePublisher(kind, {
      fetchImpl: fake.fetch,
      sleep: async () => undefined,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    video: fakeVideoSource({ sizeBytes: 2 * MB, durationSec: 45, aspectRatio: '16:9' }),
    text: 'Full description of the video',
    caption: 'Full description of the video',
    hashtags: [],
    title: 'A great video',
    accessToken: 'yt-token',
    accountId: 'channel-1',
    aiGenerated: true,
    ...overrides,
  };
}

function sessionResponse(location: string) {
  return new Response(null, { status: 200, headers: { Location: location } });
}

describe('YouTubePublisher.publish', () => {
  it('sends the resumable upload request sequence and returns the video id', async () => {
    const { youtube, requests } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-1'),
      json({ id: 'yt-vid-1' }),
      json({ items: [{ status: { uploadStatus: 'uploaded' } }] }),
    );

    const result = await youtube.publish(request());

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      url: `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      method: 'POST',
      headers: {
        authorization: 'Bearer yt-token',
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(2 * MB),
        'x-upload-content-type': 'video/mp4',
      },
      body: {
        snippet: {
          title: 'A great video',
          description: 'Full description of the video',
          categoryId: '22',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: true,
        },
      },
    });
    expect(requests[1]).toMatchObject({
      url: 'https://upload.googleapis.com/session-1',
      method: 'PUT',
      headers: {
        authorization: 'Bearer yt-token',
        'content-length': String(2 * MB),
        'content-range': `bytes 0-${2 * MB - 1}/${2 * MB}`,
      },
    });
    expect(requests[2]).toMatchObject({
      url: `https://www.googleapis.com/youtube/v3/videos?part=status&id=yt-vid-1`,
      headers: { authorization: 'Bearer yt-token' },
    });
    expect(result).toEqual({
      platformPostId: 'yt-vid-1',
      platformUrl: null,
      metadata: { uploadStatus: 'uploaded', privacyStatus: 'public', shorts: false },
    });
  });

  it('marks Shorts uploads in metadata and uses a custom privacy status', async () => {
    const { youtube } = publisher(
      'youtube_short',
      sessionResponse('https://upload.googleapis.com/session-2'),
      json({ id: 'yt-vid-2' }),
      json({ items: [{ status: { uploadStatus: 'processed' } }] }),
    );

    const result = await youtube.publish(request({ options: { privacyStatus: 'unlisted' } }));

    expect(result.metadata).toMatchObject({ shorts: true, privacyStatus: 'unlisted' });
  });

  it('continues a resumable upload across a 308 response using the Range header', async () => {
    const size = CHUNK_SIZE + 1000;
    const { youtube, requests } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-3'),
      new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } }),
      json({ id: 'yt-vid-3' }),
      json({ items: [{ status: { uploadStatus: 'uploaded' } }] }),
    );

    await youtube.publish(request({ video: fakeVideoSource({ sizeBytes: size }) }));

    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0]?.headers['content-range']).toBe(`bytes 0-${CHUNK_SIZE - 1}/${size}`);
    expect(puts[1]?.headers['content-range']).toBe(`bytes ${CHUNK_SIZE}-${size - 1}/${size}`);
  });

  it('falls back to the chunk end when the platform omits a Range header on 308', async () => {
    const size = CHUNK_SIZE + 1000;
    const { youtube, requests } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-4'),
      new Response(null, { status: 308 }),
      json({ id: 'yt-vid-4' }),
      json({ items: [{ status: { uploadStatus: 'uploaded' } }] }),
    );

    await youtube.publish(request({ video: fakeVideoSource({ sizeBytes: size }) }));

    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts[1]?.headers['content-range']).toBe(`bytes ${CHUNK_SIZE}-${size - 1}/${size}`);
  });

  it('throws when the resumable session response has no Location header', async () => {
    const { youtube, requests } = publisher('youtube', new Response(null, { status: 200 }));

    await expect(youtube.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
    expect(requests).toHaveLength(1);
  });

  it('throws when the upload finishes without ever returning a video body', async () => {
    const { youtube } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-5'),
      new Response(null, { status: 308, headers: { Range: `bytes=0-${2 * MB - 1}` } }),
    );

    await expect(youtube.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('maps a failed processing status to a non-retryable invalid_media error', async () => {
    const { youtube } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-6'),
      json({ id: 'yt-vid-6' }),
      json({ items: [{ status: { uploadStatus: 'failed', failureReason: 'codec' } }] }),
    );

    await expect(youtube.publish(request())).rejects.toMatchObject({
      errorClass: 'invalid_media',
      retryable: false,
      message: expect.stringContaining('codec'),
    });
  });

  it('maps a rejected processing status to a non-retryable content_policy error', async () => {
    const { youtube } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-7'),
      json({ id: 'yt-vid-7' }),
      json({ items: [{ status: { uploadStatus: 'rejected', rejectionReason: 'legal' } }] }),
    );

    await expect(youtube.publish(request())).rejects.toMatchObject({
      errorClass: 'content_policy',
      retryable: false,
      message: expect.stringContaining('legal'),
    });
  });

  it('keeps polling status until the video is processed', async () => {
    const { youtube, requests } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-8'),
      json({ id: 'yt-vid-8' }),
      json({ items: [{ status: { uploadStatus: 'uploading' } }] }),
      json({ items: [{ status: { uploadStatus: 'processed' } }] }),
    );

    await youtube.publish(request());
    expect(requests).toHaveLength(4);
  });

  it.each([
    ['quotaExceeded', 'quota_exceeded', false],
    ['uploadLimitExceeded', 'quota_exceeded', false],
    ['rateLimitExceeded', 'rate_limited', true],
    ['forbidden', 'invalid_request', false],
  ])('classifies session-init failure reason %s as %s', async (reason, errorClass, retryable) => {
    const { youtube } = publisher(
      'youtube',
      json({ error: { code: 403, message: 'nope', errors: [{ reason }] } }, 403),
    );

    await expect(youtube.publish(request())).rejects.toMatchObject({ errorClass, retryable });
  });

  it('falls back to the error code in the message when no reason is present', async () => {
    const { youtube } = publisher('youtube', json({ error: { code: 500, message: 'boom' } }, 500));

    await expect(youtube.publish(request())).rejects.toMatchObject({
      errorClass: 'unavailable',
      message: '500: boom',
    });
  });
});

describe('YouTubePublisher.takedown', () => {
  it('DELETEs the video by id', async () => {
    const { youtube, requests } = publisher('youtube', new Response(null, { status: 204 }));

    await youtube.takedown({
      accessToken: 'yt-token',
      accountId: 'channel-1',
      platformPostId: 'yt-vid-1',
    });

    expect(requests[0]).toMatchObject({
      url: 'https://www.googleapis.com/youtube/v3/videos?id=yt-vid-1',
      method: 'DELETE',
      headers: { authorization: 'Bearer yt-token' },
    });
  });

  it('throws a PlatformError when the delete fails', async () => {
    const { youtube } = publisher('youtube', json({ error: { code: 404, message: 'gone' } }, 404));

    await expect(
      youtube.takedown({
        accessToken: 'yt-token',
        accountId: 'channel-1',
        platformPostId: 'missing',
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

describe('YouTubePublisher thumbnails.set + captions.insert (15.A3 / 15.A4)', () => {
  const thumbnail = {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    contentType: 'image/jpeg' as const,
  };
  const captions = {
    srt: '1\n00:00:00,000 --> 00:00:01,000\nHola\n',
    language: 'es',
    name: 'Studio narration',
  };

  it('sets the custom thumbnail and uploads the SRT track after the upload', async () => {
    const { youtube, requests } = publisher(
      'youtube',
      sessionResponse('https://upload.googleapis.com/session-t'),
      json({ id: 'yt-t' }),
      json({ items: [{ status: { uploadStatus: 'processed' } }] }),
      json({ kind: 'youtube#thumbnailSetResponse' }),
      json({ id: 'track-1' }),
    );
    const result = await youtube.publish(request({ thumbnail, captions }));

    expect(requests[3]).toMatchObject({
      url: `${THUMBNAIL_URL}?videoId=yt-t&uploadType=media`,
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', authorization: 'Bearer yt-token' },
    });
    expect(requests[4]?.url).toBe(`${CAPTIONS_URL}?uploadType=multipart&part=snippet`);
    expect(requests[4]?.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    const body = String(requests[4]?.body);
    expect(body).toContain('"videoId":"yt-t"');
    expect(body).toContain('"language":"es"');
    expect(body).toContain('Hola');
    expect(result.metadata).toMatchObject({
      thumbnail: 'set',
      captions: 'uploaded',
      captionTrackId: 'track-1',
    });
  });

  it('records a thumbnail or caption failure without failing the publish', async () => {
    const { youtube } = publisher(
      'youtube_short',
      sessionResponse('https://upload.googleapis.com/session-u'),
      json({ id: 'yt-u' }),
      json({ items: [{ status: { uploadStatus: 'processed' } }] }),
      json({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403),
      json({ error: { code: 409, errors: [{ reason: 'captionExists' }] } }, 409),
    );
    const result = await youtube.publish(request({ thumbnail, captions }));
    expect(result.platformPostId).toBe('yt-u');
    expect(result.metadata).toMatchObject({ thumbnail: 'failed', captions: 'failed' });
  });
});
