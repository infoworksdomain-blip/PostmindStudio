import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { fakeVideoSource } from '../../../../test/helpers/fake-video-source';
import { buildCommentary, escapeLittleText, LINKEDIN_VERSION, LinkedInPublisher } from './linkedin';
import type { PublishRequest } from './interface';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const MB = 1024 * 1024;

function publisher(...replies: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...replies);
  return {
    linkedin: new LinkedInPublisher({
      fetchImpl: fake.fetch,
      sleep: async () => undefined,
      now: () => NOW,
    }),
    requests: fake.requests,
  };
}

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    video: fakeVideoSource({ sizeBytes: 2 * MB, durationSec: 60, aspectRatio: '16:9' }),
    text: 'Fresh bread rising\n\n#baking',
    caption: 'Fresh bread rising',
    hashtags: ['baking'],
    title: 'A great video',
    accessToken: 'li-token',
    accountId: 'urn:li:organization:42',
    aiGenerated: true,
    ...overrides,
  };
}

describe('escapeLittleText', () => {
  it('backslash-escapes every reserved character', () => {
    expect(escapeLittleText('a|b{c}d@e[f]g(h)i<j>k#l\\m*n_o~p')).toBe(
      'a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\\\m\\*n\\_o\\~p',
    );
  });

  it('leaves plain text untouched', () => {
    expect(escapeLittleText('Fresh bread rising, 2026!')).toBe('Fresh bread rising, 2026!');
  });
});

describe('buildCommentary', () => {
  it('joins the escaped caption and hashtag templates', () => {
    expect(buildCommentary('Fresh bread (rising)', ['baking', 'sourdough'])).toBe(
      'Fresh bread \\(rising\\)\n\n{hashtag|\\#|baking} {hashtag|\\#|sourdough}',
    );
  });

  it('omits the hashtag line when there are no hashtags', () => {
    expect(buildCommentary('Fresh bread rising', [])).toBe('Fresh bread rising');
  });

  it('trims surrounding whitespace from the caption', () => {
    expect(buildCommentary('  Fresh bread rising  ', [])).toBe('Fresh bread rising');
  });
});

describe('LinkedInPublisher.publish', () => {
  it('sends the full request sequence and returns the post urn', async () => {
    const { linkedin, requests } = publisher(
      json({
        value: {
          video: 'urn:li:video:1',
          uploadToken: 'upload-token',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/1', firstByte: 0, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201, headers: { ETag: 'etag-1' } }),
      json({}),
      json({ status: 'AVAILABLE' }),
      new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } }),
    );

    const result = await linkedin.publish(request());

    expect(requests).toHaveLength(5);
    expect(requests[0]).toMatchObject({
      url: 'https://api.linkedin.com/rest/videos?action=initializeUpload',
      method: 'POST',
      headers: {
        authorization: 'Bearer li-token',
        'linkedin-version': LINKEDIN_VERSION,
        'x-restli-protocol-version': '2.0.0',
        'content-type': 'application/json',
      },
      body: {
        initializeUploadRequest: {
          owner: 'urn:li:organization:42',
          fileSizeBytes: 2 * MB,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
    });
    expect(requests[1]).toMatchObject({
      url: 'https://up.linkedin.example/1',
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(requests[2]).toMatchObject({
      url: 'https://api.linkedin.com/rest/videos?action=finalizeUpload',
      method: 'POST',
      body: {
        finalizeUploadRequest: {
          video: 'urn:li:video:1',
          uploadToken: 'upload-token',
          uploadedPartIds: ['etag-1'],
        },
      },
    });
    expect(requests[3]).toMatchObject({
      url: 'https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3A1',
      method: 'GET',
    });
    expect(requests[4]).toMatchObject({
      url: 'https://api.linkedin.com/rest/posts',
      method: 'POST',
      body: {
        author: 'urn:li:organization:42',
        commentary: 'Fresh bread rising\n\n{hashtag|\\#|baking}',
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: { media: { title: 'A great video', id: 'urn:li:video:1' } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
    });
    expect(result).toEqual({
      platformPostId: 'urn:li:share:99',
      platformUrl: null,
      metadata: { videoUrn: 'urn:li:video:1' },
    });
  });

  it('returns a public feed URL only for ugcPost URNs', async () => {
    const { linkedin } = publisher(
      json({
        value: {
          video: 'urn:li:video:2',
          uploadToken: 'tok',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/2', firstByte: 0, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201, headers: { ETag: 'etag-2' } }),
      json({}),
      json({ status: 'AVAILABLE' }),
      new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:ugcPost:77' } }),
    );

    const result = await linkedin.publish(request());

    expect(result.platformUrl).toBe('https://www.linkedin.com/feed/update/urn:li:ugcPost:77/');
  });

  it('uploads every part and collects each ETag for multi-part videos', async () => {
    const { linkedin, requests } = publisher(
      json({
        value: {
          video: 'urn:li:video:3',
          uploadToken: 'tok',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/a', firstByte: 0, lastByte: MB - 1 },
            { uploadUrl: 'https://up.linkedin.example/b', firstByte: MB, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201, headers: { ETag: 'etag-a' } }),
      new Response(null, { status: 201, headers: { ETag: 'etag-b' } }),
      json({}),
      json({ status: 'AVAILABLE' }),
      new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }),
    );

    await linkedin.publish(request());

    const finalize = requests.find((r) => r.url.includes('finalizeUpload'));
    expect(finalize?.body).toMatchObject({
      finalizeUploadRequest: { uploadedPartIds: ['etag-a', 'etag-b'] },
    });
  });

  it('throws when initializeUpload returns no video or upload instructions', async () => {
    const { linkedin, requests } = publisher(json({ value: {} }));

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
    });
    expect(requests).toHaveLength(1);
  });

  it('throws when an upload part response has no ETag', async () => {
    const { linkedin } = publisher(
      json({
        value: {
          video: 'urn:li:video:4',
          uploadToken: 'tok',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/4', firstByte: 0, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201 }),
    );

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
      message: 'Upload part returned no ETag',
    });
  });

  it('throws a non-retryable invalid_media error when processing fails', async () => {
    const { linkedin } = publisher(
      json({
        value: {
          video: 'urn:li:video:5',
          uploadToken: 'tok',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/5', firstByte: 0, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201, headers: { ETag: 'etag-5' } }),
      json({}),
      json({ status: 'PROCESSING_FAILED', processingFailureReason: 'corrupt' }),
    );

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'invalid_media',
      retryable: false,
      message: expect.stringContaining('corrupt'),
    });
  });

  it('throws when the post is created without an x-restli-id header', async () => {
    const { linkedin } = publisher(
      json({
        value: {
          video: 'urn:li:video:6',
          uploadToken: 'tok',
          uploadInstructions: [
            { uploadUrl: 'https://up.linkedin.example/6', firstByte: 0, lastByte: 2 * MB - 1 },
          ],
        },
      }),
      new Response(null, { status: 201, headers: { ETag: 'etag-6' } }),
      json({}),
      json({ status: 'AVAILABLE' }),
      new Response(null, { status: 201 }),
    );

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'unknown',
      retryable: true,
      message: 'Post created without x-restli-id',
    });
  });

  it('classifies CONTENT_BLOCKED as a non-retryable content_policy error', async () => {
    const { linkedin } = publisher(json({ message: 'blocked', code: 'CONTENT_BLOCKED' }, 422));

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'content_policy',
      retryable: false,
    });
  });

  it('classifies a 403 ACCESS_DENIED as needs_reconnect', async () => {
    const { linkedin } = publisher(json({ message: 'denied', code: 'ACCESS_DENIED' }, 403));

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'needs_reconnect',
      retryable: false,
    });
  });

  it('falls back to the default status classification when no code matches', async () => {
    const { linkedin } = publisher(json({ message: 'server error', serviceErrorCode: 500 }, 500));

    await expect(linkedin.publish(request())).rejects.toMatchObject({
      errorClass: 'unavailable',
      retryable: true,
      message: 'server error',
    });
  });
});

describe('LinkedInPublisher.takedown', () => {
  it('DELETEs the post with the restli method override header', async () => {
    const { linkedin, requests } = publisher(new Response(null, { status: 204 }));

    await linkedin.takedown({
      accessToken: 'li-token',
      accountId: 'urn:li:organization:42',
      platformPostId: 'urn:li:share:99',
    });

    expect(requests[0]).toMatchObject({
      url: 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A99',
      method: 'DELETE',
      headers: {
        authorization: 'Bearer li-token',
        'linkedin-version': LINKEDIN_VERSION,
        'x-restli-protocol-version': '2.0.0',
        'x-restli-method': 'DELETE',
      },
    });
  });

  it('throws a PlatformError when the delete fails', async () => {
    const { linkedin } = publisher(json({ message: 'not found' }, 404));

    await expect(
      linkedin.takedown({
        accessToken: 'li-token',
        accountId: 'urn:li:organization:42',
        platformPostId: 'urn:li:share:missing',
      }),
    ).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});
