import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { fakeVideoSource } from '../../../../test/helpers/fake-video-source';
import { SEGMENT_BYTES, XPublisher } from './x';
import type { PublishRequest } from './interface';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MB = 1024 * 1024;

function publisher(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    x: new XPublisher({ fetchImpl: fake.fetch, sleep: async () => undefined, now: () => NOW }),
    requests: fake.requests,
  };
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    video: fakeVideoSource({ sizeBytes: 2 * MB, durationSec: 30, aspectRatio: '16:9' }),
    text: 'Fresh bread rising #baking',
    caption: 'Fresh bread rising',
    hashtags: ['baking'],
    accessToken: 'x-token',
    accountId: 'user-1',
    aiGenerated: true,
    ...overrides,
  };
}

describe('XPublisher.publish', () => {
  it('sends the full request sequence and returns the tweet id', async () => {
    const { x, requests } = publisher(
      json({ data: { id: 'media-1' } }),
      json({}),
      json({ data: {} }),
      json({ data: { id: 'tweet-1' } }),
    );

    const result = await x.publish(request());

    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      url: 'https://api.x.com/2/media/upload/initialize',
      method: 'POST',
      headers: { authorization: 'Bearer x-token', 'content-type': 'application/json' },
      body: { media_type: 'video/mp4', total_bytes: 2 * MB, media_category: 'tweet_video' },
    });
    expect(requests[1]).toMatchObject({
      url: 'https://api.x.com/2/media/upload/media-1/append',
      method: 'POST',
      headers: { authorization: 'Bearer x-token' },
    });
    const form = requests[1]?.body as FormData;
    expect(form.get('segment_index')).toBe('0');
    expect(form.get('media')).toBeInstanceOf(Blob);
    expect(requests[2]).toMatchObject({
      url: 'https://api.x.com/2/media/upload/media-1/finalize',
      method: 'POST',
    });
    expect(requests[3]).toMatchObject({
      url: 'https://api.x.com/2/tweets',
      method: 'POST',
      body: { text: 'Fresh bread rising #baking', media: { media_ids: ['media-1'] } },
    });
    expect(result).toEqual({
      platformPostId: 'tweet-1',
      platformUrl: null,
      metadata: { mediaId: 'media-1', processing: 'none' },
    });
  });

  it('uploads multiple segments for a file larger than the segment size', async () => {
    const size = Math.floor(SEGMENT_BYTES * 1.5);
    const { x, requests } = publisher(
      json({ data: { id: 'media-2' } }),
      json({}),
      json({}),
      json({ data: {} }),
      json({ data: { id: 'tweet-2' } }),
    );

    await x.publish(request({ video: fakeVideoSource({ sizeBytes: size }) }));

    const appends = requests.filter((r) => r.url.endsWith('/append'));
    expect(appends).toHaveLength(2);
    expect((appends[0]?.body as FormData).get('segment_index')).toBe('0');
    expect((appends[1]?.body as FormData).get('segment_index')).toBe('1');
  });

  it('polls processing status until succeeded before creating the tweet', async () => {
    const { x, requests } = publisher(
      json({ data: { id: 'media-3' } }),
      json({}),
      json({ data: { processing_info: { state: 'pending', check_after_secs: 1 } } }),
      json({ data: { processing_info: { state: 'in_progress', check_after_secs: 2 } } }),
      json({ data: { processing_info: { state: 'succeeded' } } }),
      json({ data: { id: 'tweet-3' } }),
    );

    const result = await x.publish(request());

    expect(requests.filter((r) => r.url.includes('command=STATUS'))).toHaveLength(2);
    expect(result.metadata).toMatchObject({ processing: 'succeeded' });
  });

  it('throws a non-retryable invalid_media error when processing fails', async () => {
    const { x } = publisher(
      json({ data: { id: 'media-4' } }),
      json({}),
      json({ data: { processing_info: { state: 'pending', check_after_secs: 1 } } }),
      json({ data: { processing_info: { state: 'failed' } } }),
    );

    await expect(x.publish(request())).rejects.toMatchObject({
      errorClass: 'invalid_media',
      retryable: false,
      message: expect.stringContaining('X media processing failed'),
    });
  });

  it('throws when media initialize returns no id', async () => {
    const { x, requests } = publisher(json({ data: {} }));

    await expect(x.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
    expect(requests).toHaveLength(1);
  });

  it('throws when tweet creation returns no id', async () => {
    const { x } = publisher(
      json({ data: { id: 'media-5' } }),
      json({}),
      json({ data: {} }),
      json({ data: {} }),
    );

    await expect(x.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
  });

  it('classifies HTTP failures via the errors[].code and detail fields', async () => {
    const { x } = publisher(
      json({ detail: 'Client Forbidden', errors: [{ message: 'no access', code: 453 }] }, 403),
    );

    await expect(x.publish(request())).rejects.toMatchObject({
      errorClass: 'invalid_request',
      retryable: false,
      message: 'Client Forbidden',
    });
  });

  it('classifies rate limiting via the default status mapping', async () => {
    const { x } = publisher(json({ title: 'Too Many Requests' }, 429));

    await expect(x.publish(request())).rejects.toMatchObject({
      errorClass: 'rate_limited',
      retryable: true,
      message: 'Too Many Requests',
    });
  });
});

describe('XPublisher.takedown', () => {
  it('DELETEs the tweet and resolves when X confirms deletion', async () => {
    const { x, requests } = publisher(json({ data: { deleted: true } }));

    await x.takedown({ accessToken: 'x-token', accountId: 'user-1', platformPostId: 'tweet-1' });

    expect(requests[0]).toMatchObject({
      url: 'https://api.x.com/2/tweets/tweet-1',
      method: 'DELETE',
      headers: { authorization: 'Bearer x-token' },
    });
  });

  it('throws when X does not confirm deletion', async () => {
    const { x } = publisher(json({ data: { deleted: false } }));

    await expect(
      x.takedown({ accessToken: 'x-token', accountId: 'user-1', platformPostId: 'tweet-1' }),
    ).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
      message: 'X did not confirm deletion',
    });
  });
});
