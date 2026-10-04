import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import type { CarouselPublishRequest, CarouselSlideSource } from './interface';
import { API as LINKEDIN_API, LinkedInPublisher, LINKEDIN_VERSION } from './linkedin';
import {
  DEFAULT_GRAPH_VERSION,
  FacebookFeedPublisher,
  GRAPH_HOST,
  InstagramReelPublisher,
} from './meta';
import { API as TIKTOK_API, TikTokPublisher } from './tiktok';

// 21.6: carousel request shapes per platform (docs cited in each publisher).

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  sleep: vi.fn(async () => undefined),
  now: vi.fn(() => 0),
});

const slide = (n: number): CarouselSlideSource => ({
  jpegUrl: `https://cdn.example/slide-${n}.jpg`,
  readJpeg: vi.fn(async () => new Uint8Array([n])),
  width: 1080,
  height: 1350,
  altText: `Slide ${n} words`,
});

const request = (
  count: number,
  over: Partial<CarouselPublishRequest> = {},
): CarouselPublishRequest => ({
  slides: Array.from({ length: count }, (_, i) => slide(i + 1)),
  text: 'Seven things\n\n#bread #cake',
  caption: 'Seven things',
  hashtags: ['bread', 'cake'],
  accessToken: 'tok',
  accountId: 'acct',
  aiGenerated: true,
  ...over,
});

const graph = (path: string) => `${GRAPH_HOST}/${DEFAULT_GRAPH_VERSION}${path}`;

describe('Instagram carousel', () => {
  it('creates item containers, a CAROUSEL container with children, waits and publishes', async () => {
    const { fetch, requests } = fakeFetch(
      json({ id: 'c1' }),
      json({ id: 'c2' }),
      json({ id: 'parent' }),
      json({ status_code: 'FINISHED' }),
      json({ id: 'media-9' }),
      json({ permalink: 'https://instagram.com/p/x', shortcode: 'x', timestamp: 't' }),
    );
    const result = await new InstagramReelPublisher(deps(fetch), 'instagram_feed').publishCarousel(
      request(2),
    );
    expect(result).toMatchObject({
      platformPostId: 'media-9',
      platformUrl: 'https://instagram.com/p/x',
    });
    expect(result.metadata).toMatchObject({ containerId: 'parent', children: ['c1', 'c2'] });
    const item = requests[0]?.body as URLSearchParams;
    expect(requests[0]?.url).toBe(graph('/acct/media'));
    expect(item.get('image_url')).toBe('https://cdn.example/slide-1.jpg');
    expect(item.get('is_carousel_item')).toBe('true');
    // The AI label goes on the carousel container only (an error on children).
    expect(item.get('is_ai_generated')).toBeNull();
    const parent = requests[2]?.body as URLSearchParams;
    expect(parent.get('media_type')).toBe('CAROUSEL');
    expect(parent.get('children')).toBe('c1,c2');
    expect(parent.get('caption')).toBe('Seven things\n\n#bread #cake');
    expect(parent.get('is_ai_generated')).toBe('true');
    expect(requests[3]?.method).toBe('GET');
    expect(requests[4]?.url).toBe(graph('/acct/media_publish'));
    expect((requests[4]?.body as URLSearchParams).get('creation_id')).toBe('parent');
  });

  it('omits the AI label when no picture is AI-generated', async () => {
    const { fetch, requests } = fakeFetch(
      json({ id: 'c1' }),
      json({ id: 'c2' }),
      json({ id: 'parent' }),
      json({ status_code: 'FINISHED' }),
      json({ id: 'm' }),
      json({}),
    );
    await new InstagramReelPublisher(deps(fetch), 'instagram_feed').publishCarousel(
      request(2, { aiGenerated: false }),
    );
    expect((requests[2]?.body as URLSearchParams).get('is_ai_generated')).toBeNull();
  });

  it('refuses more than 10 slides before calling Instagram', async () => {
    const { fetch, requests } = fakeFetch();
    await expect(
      new InstagramReelPublisher(deps(fetch), 'instagram_feed').publishCarousel(request(11)),
    ).rejects.toMatchObject({ errorClass: 'invalid_media', retryable: false });
    expect(requests).toHaveLength(0);
  });
});

describe('Facebook multi-photo post', () => {
  it('uploads unpublished photos then posts them with attached_media', async () => {
    const { fetch, requests } = fakeFetch(
      json({ id: 'ph1' }),
      json({ id: 'ph2' }),
      json({ id: 'page_post_1' }),
    );
    const result = await new FacebookFeedPublisher(deps(fetch)).publishCarousel(request(2));
    expect(result).toEqual({
      platformPostId: 'page_post_1',
      platformUrl: 'https://www.facebook.com/page_post_1',
      metadata: { photoIds: ['ph1', 'ph2'] },
    });
    expect(requests[0]?.url).toBe(graph('/acct/photos'));
    const photo = requests[0]?.body as URLSearchParams;
    expect(photo.get('url')).toBe('https://cdn.example/slide-1.jpg');
    expect(photo.get('published')).toBe('false');
    expect(requests[2]?.url).toBe(graph('/acct/feed'));
    const feed = requests[2]?.body as URLSearchParams;
    expect(feed.get('message')).toBe('Seven things\n\n#bread #cake');
    expect(feed.get('attached_media[0]')).toBe('{"media_fbid":"ph1"}');
    expect(feed.get('attached_media[1]')).toBe('{"media_fbid":"ph2"}');
  });
});

describe('LinkedIn multi-image post', () => {
  it('initialises and PUTs each image, then posts content.multiImage', async () => {
    const { fetch, requests } = fakeFetch(
      json({ value: { uploadUrl: 'https://upload.example/1', image: 'urn:li:image:1' } }),
      new Response(null, { status: 201 }),
      json({ value: { uploadUrl: 'https://upload.example/2', image: 'urn:li:image:2' } }),
      new Response(null, { status: 201 }),
      new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } }),
    );
    const result = await new LinkedInPublisher(deps(fetch)).publishCarousel(
      request(2, { accountId: 'urn:li:organization:5' }),
    );
    expect(result.platformPostId).toBe('urn:li:share:9');
    expect(result.platformUrl).toBeNull();
    expect(requests[0]?.url).toBe(`${LINKEDIN_API}/images?action=initializeUpload`);
    expect(requests[0]?.headers['linkedin-version']).toBe(LINKEDIN_VERSION);
    expect(requests[0]?.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(requests[0]?.body).toEqual({
      initializeUploadRequest: { owner: 'urn:li:organization:5' },
    });
    expect(requests[1]).toMatchObject({ url: 'https://upload.example/1', method: 'PUT' });
    expect(requests[1]?.headers.authorization).toBe('Bearer tok');
    const post = requests[4]?.body as { content: unknown; author: string; commentary: string };
    expect(requests[4]?.url).toBe(`${LINKEDIN_API}/posts`);
    expect(post.author).toBe('urn:li:organization:5');
    expect(post.content).toEqual({
      multiImage: {
        images: [
          { id: 'urn:li:image:1', altText: 'Slide 1 words' },
          { id: 'urn:li:image:2', altText: 'Slide 2 words' },
        ],
      },
    });
  });

  it('needs at least two images', async () => {
    const { fetch } = fakeFetch();
    await expect(
      new LinkedInPublisher(deps(fetch)).publishCarousel(request(1)),
    ).rejects.toMatchObject({
      errorClass: 'invalid_media',
    });
  });
});

describe('TikTok photo post', () => {
  it('direct-posts PHOTO media pulled from the slide URLs', async () => {
    const { fetch, requests } = fakeFetch(
      json({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] } }),
      json({ data: { publish_id: 'pub-1' } }),
      json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [42] } }),
    );
    const result = await new TikTokPublisher(deps(fetch)).publishCarousel(
      request(3, { grantedScopes: ['video.publish'] }),
    );
    expect(result).toMatchObject({ platformPostId: '42', metadata: { tiktokMode: 'direct' } });
    expect(requests[1]?.url).toBe(`${TIKTOK_API}/v2/post/publish/content/init/`);
    expect(requests[1]?.body).toEqual({
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      post_info: {
        title: 'Seven things',
        description: 'Seven things\n\n#bread #cake',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_comment: false,
        auto_add_music: true,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: [
          'https://cdn.example/slide-1.jpg',
          'https://cdn.example/slide-2.jpg',
          'https://cdn.example/slide-3.jpg',
        ],
        photo_cover_index: 0,
      },
      is_aigc: true,
    });
  });

  it('sends the photos to the inbox (MEDIA_UPLOAD) with only the upload scope', async () => {
    const { fetch, requests } = fakeFetch(
      json({ data: { publish_id: 'pub-2' } }),
      json({ data: { status: 'SEND_TO_USER_INBOX' } }),
    );
    const result = await new TikTokPublisher(deps(fetch)).publishCarousel(
      request(2, { grantedScopes: ['video.upload'], aiGenerated: false }),
    );
    expect(result.metadata).toMatchObject({ tiktokMode: 'inbox', publishId: 'pub-2' });
    const body = requests[0]?.body as { post_mode: string; post_info: object; is_aigc?: boolean };
    expect(body.post_mode).toBe('MEDIA_UPLOAD');
    expect(body.post_info).toEqual({
      title: 'Seven things',
      description: 'Seven things\n\n#bread #cake',
    });
    expect(body.is_aigc).toBeUndefined();
  });

  it('reports an unverified URL domain as a non-retryable request error', async () => {
    const { fetch } = fakeFetch(
      json({ data: { privacy_level_options: ['SELF_ONLY'] } }),
      json({ error: { code: 'url_ownership_unverified', message: 'verify' } }, 403),
    );
    await expect(
      new TikTokPublisher(deps(fetch)).publishCarousel(request(2)),
    ).rejects.toMatchObject({ errorClass: 'invalid_request', retryable: false });
  });
});
