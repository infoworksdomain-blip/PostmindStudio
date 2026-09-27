import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { NotImplementedError } from '../../errors';
import {
  createLinkedInMetrics,
  createMetricsRegistry,
  createTikTokMetrics,
  createXMetrics,
  createYouTubeMetrics,
  isTikTokPostId,
  linkedInEntity,
  readReport,
} from './fetchers';
import type { FetchMetricsRequest } from './fetchers';

const NOW = Date.parse('2026-09-27T12:00:00Z');

function baseRequest(overrides: Partial<FetchMetricsRequest> = {}): FetchMetricsRequest {
  return {
    accessToken: 'tok',
    accountId: 'account-1',
    platformPostId: '123456789',
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------- isTikTokPostId

describe('isTikTokPostId', () => {
  it('accepts a numeric int64-like id', () => {
    expect(isTikTokPostId('12345')).toBe(true);
    expect(isTikTokPostId('7276871234567891234')).toBe(true);
  });

  it('rejects publish ids', () => {
    expect(isTikTokPostId('v_pub_url~abc123')).toBe(false);
  });

  it('rejects short numeric strings (below the 5-digit floor)', () => {
    expect(isTikTokPostId('1234')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isTikTokPostId('')).toBe(false);
  });

  it('rejects numeric ids with non-digit characters mixed in', () => {
    expect(isTikTokPostId('12345a')).toBe(false);
  });
});

// ---------------------------------------------------------------- TikTok

describe('createTikTokMetrics', () => {
  it('queries the video directly by numeric post id', async () => {
    const fake = fakeFetch(
      json({
        data: {
          videos: [
            { id: '123456789', view_count: 10, like_count: 2, comment_count: 1, share_count: 0 },
          ],
        },
      }),
    );
    const fetcher = createTikTokMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest());

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count',
      method: 'POST',
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
      },
      body: { filters: { video_ids: ['123456789'] } },
    });
    expect(result).toEqual({
      platformPostId: '123456789',
      snapshot: { views: 10, likes: 2, comments: 1, shares: 0 },
      unavailable: ['watch_time', 'avg_watch_pct'],
    });
  });

  it('resolves a publish id via publish/status/fetch before querying the video', async () => {
    const fake = fakeFetch(
      json({ data: { publicaly_available_post_id: [987654321] } }),
      json({
        data: {
          videos: [
            { id: '987654321', view_count: 5, like_count: 1, comment_count: 0, share_count: 0 },
          ],
        },
      }),
    );
    const fetcher = createTikTokMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'v_pub_url~abc' }));

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toMatchObject({
      url: 'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json; charset=UTF-8' },
      body: { publish_id: 'v_pub_url~abc' },
    });
    expect(fake.requests[1]).toMatchObject({
      body: { filters: { video_ids: ['987654321'] } },
    });
    expect(result.platformPostId).toBe('987654321');
    expect(result.snapshot).toEqual({ views: 5, likes: 1, comments: 0, shares: 0 });
  });

  it('returns a zero snapshot with not_public_yet when the post is not public yet', async () => {
    const fake = fakeFetch(json({ data: {} }));
    const fetcher = createTikTokMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'v_pub_url~pending' }));

    expect(fake.requests).toHaveLength(1);
    expect(result).toEqual({
      snapshot: { views: 0, likes: 0, comments: 0, shares: 0 },
      unavailable: ['not_public_yet'],
    });
  });

  it('throws a PlatformError when the video query returns no matching video', async () => {
    const fake = fakeFetch(json({ data: { videos: [] } }));
    const fetcher = createTikTokMetrics({ fetchImpl: fake.fetch });

    await expect(fetcher.fetch(baseRequest())).rejects.toMatchObject({
      platform: 'tiktok',
      errorClass: 'invalid_request',
      retryable: true,
      message: 'TikTok returned no metrics for this post',
    });
  });

  it('has the tiktok platform id', () => {
    const fetcher = createTikTokMetrics({ fetchImpl: fakeFetch().fetch });
    expect(fetcher.platform).toBe('tiktok');
  });
});

// ---------------------------------------------------------------- YouTube

describe('readReport', () => {
  it('maps column headers to the first row of values', () => {
    const report = {
      columnHeaders: [{ name: 'estimatedMinutesWatched' }, { name: 'shares' }],
      rows: [[42, 3]],
    };
    expect(readReport(report)).toEqual({ estimatedMinutesWatched: 42, shares: 3 });
  });

  it('returns an empty object when there are no rows', () => {
    expect(readReport({ columnHeaders: [{ name: 'shares' }], rows: [] })).toEqual({});
  });

  it('returns an empty object when rows is undefined', () => {
    expect(readReport({ columnHeaders: [{ name: 'shares' }] })).toEqual({});
  });

  it('defaults missing header metadata to no columns', () => {
    expect(readReport({ rows: [[1, 2]] })).toEqual({});
  });

  it('coerces string values to numbers', () => {
    expect(readReport({ columnHeaders: [{ name: 'shares' }], rows: [['7']] })).toEqual({
      shares: 7,
    });
  });
});

describe('createYouTubeMetrics', () => {
  it('parses numeric-string statistics and maps the analytics report', async () => {
    const fake = fakeFetch(
      json({ items: [{ statistics: { viewCount: '100', likeCount: '20', commentCount: '5' } }] }),
      json({
        columnHeaders: [
          { name: 'estimatedMinutesWatched' },
          { name: 'averageViewPercentage' },
          { name: 'shares' },
        ],
        rows: [[10, 55.5, 3]],
      }),
    );
    const fetcher = createYouTubeMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'yt-vid-1' }));

    expect(fake.requests[0]).toMatchObject({
      url: 'https://www.googleapis.com/youtube/v3/videos?part=statistics&id=yt-vid-1',
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
    });
    expect(fake.requests[1]?.url).toContain(
      'https://youtubeanalytics.googleapis.com/v2/reports?ids=channel%3D%3DMINE',
    );
    expect(fake.requests[1]?.url).toContain('filters=video%3D%3Dyt-vid-1');
    expect(result).toEqual({
      snapshot: {
        views: 100,
        likes: 20,
        comments: 5,
        shares: 3,
        watchTimeSec: 600,
        avgWatchTimePct: 0.555,
      },
      unavailable: [],
    });
  });

  it('still returns the public counters when the analytics report request is forbidden', async () => {
    const fake = fakeFetch(
      json({ items: [{ statistics: { viewCount: '9', likeCount: '1', commentCount: '0' } }] }),
      json({ error: { message: 'forbidden' } }, 403),
    );
    const fetcher = createYouTubeMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'yt-vid-2' }));

    expect(result.snapshot).toEqual({ views: 9, likes: 1, comments: 0, shares: 0 });
    expect(result.unavailable).toEqual(['watch_time', 'avg_watch_pct', 'shares']);
  });

  it('throws a PlatformError when statistics are missing', async () => {
    const fake = fakeFetch(json({ items: [] }));
    const fetcher = createYouTubeMetrics({ fetchImpl: fake.fetch });

    await expect(fetcher.fetch(baseRequest({ platformPostId: 'yt-vid-3' }))).rejects.toMatchObject({
      platform: 'youtube',
      errorClass: 'invalid_request',
      retryable: true,
      message: 'YouTube returned no statistics',
    });
  });

  it('has the youtube_short platform id', () => {
    const fetcher = createYouTubeMetrics({ fetchImpl: fakeFetch().fetch });
    expect(fetcher.platform).toBe('youtube_short');
  });
});

// ---------------------------------------------------------------- X

describe('createXMetrics', () => {
  it('requests non_public_metrics when the post is within the 30 day window and maps fields', async () => {
    const fake = fakeFetch(
      json({
        data: {
          public_metrics: {
            impression_count: 200,
            like_count: 10,
            reply_count: 3,
            retweet_count: 4,
            quote_count: 1,
            bookmark_count: 2,
          },
          non_public_metrics: { url_link_clicks: 6 },
        },
      }),
    );
    const fetcher = createXMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(
      baseRequest({ platformPostId: 'tweet-1', publishedAt: new Date(NOW - 5 * 86_400_000) }),
    );

    expect(fake.requests[0]?.url).toBe(
      'https://api.x.com/2/tweets/tweet-1?tweet.fields=public_metrics,non_public_metrics',
    );
    expect(result).toEqual({
      snapshot: { views: 200, likes: 10, comments: 3, shares: 5, saves: 2, clicks: 6 },
      unavailable: ['watch_time', 'avg_watch_pct'],
    });
  });

  it('requests only public_metrics once the post is older than 30 days', async () => {
    const fake = fakeFetch(
      json({
        data: {
          public_metrics: {
            impression_count: 50,
            like_count: 1,
            reply_count: 0,
            retweet_count: 0,
            quote_count: 0,
            bookmark_count: 0,
          },
        },
      }),
    );
    const fetcher = createXMetrics({ fetchImpl: fake.fetch });

    await fetcher.fetch(
      baseRequest({ platformPostId: 'tweet-2', publishedAt: new Date(NOW - 31 * 86_400_000) }),
    );

    expect(fake.requests[0]?.url).toBe(
      'https://api.x.com/2/tweets/tweet-2?tweet.fields=public_metrics',
    );
  });

  it('defaults every counter to zero when public_metrics fields and non_public_metrics are absent', async () => {
    const fake = fakeFetch(json({ data: { public_metrics: {} } }));
    const fetcher = createXMetrics({ fetchImpl: fake.fetch });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'tweet-empty' }));

    expect(result.snapshot).toEqual({
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      clicks: 0,
    });
  });

  it('throws a PlatformError when public_metrics is missing', async () => {
    const fake = fakeFetch(json({ data: {} }));
    const fetcher = createXMetrics({ fetchImpl: fake.fetch });

    await expect(fetcher.fetch(baseRequest({ platformPostId: 'tweet-3' }))).rejects.toMatchObject({
      platform: 'x',
      errorClass: 'invalid_request',
      retryable: true,
      message: 'X returned no metrics for this post',
    });
  });

  it('has the x platform id', () => {
    const fetcher = createXMetrics({ fetchImpl: fakeFetch().fetch });
    expect(fetcher.platform).toBe('x');
  });
});

// ---------------------------------------------------------------- LinkedIn

describe('linkedInEntity', () => {
  it('encodes a share URN with the share key', () => {
    expect(linkedInEntity('urn:li:share:99')).toBe('(share:urn%3Ali%3Ashare%3A99)');
  });

  it('encodes a ugcPost URN with the ugc key', () => {
    expect(linkedInEntity('urn:li:ugcPost:77')).toBe('(ugc:urn%3Ali%3AugcPost%3A77)');
  });
});

describe('createLinkedInMetrics', () => {
  it('throws NotImplementedError when the feature is disabled', async () => {
    const fetcher = createLinkedInMetrics({ fetchImpl: fakeFetch().fetch, enabled: false });

    await expect(
      fetcher.fetch(baseRequest({ platformPostId: 'urn:li:share:99' })),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('sends one request per metric with the LinkedIn headers and sums counts', async () => {
    const fake = fakeFetch(
      json({ elements: [{ count: 10 }, { count: 5 }] }),
      json({ elements: [{ count: 3 }] }),
      json({ elements: [{ count: 1 }] }),
      json({ elements: [{ count: 2 }] }),
    );
    const fetcher = createLinkedInMetrics({ fetchImpl: fake.fetch, enabled: true });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'urn:li:share:99' }));

    expect(fake.requests).toHaveLength(4);
    for (const req of fake.requests) {
      expect(req.headers).toMatchObject({
        authorization: 'Bearer tok',
        'linkedin-version': '202609',
        'x-restli-protocol-version': '2.0.0',
      });
    }
    expect(fake.requests[0]?.url).toBe(
      'https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=(share:urn%3Ali%3Ashare%3A99)&queryType=IMPRESSION&aggregation=TOTAL',
    );
    expect(fake.requests[1]?.url).toContain('queryType=REACTION');
    expect(fake.requests[2]?.url).toContain('queryType=COMMENT');
    expect(fake.requests[3]?.url).toContain('queryType=RESHARE');
    expect(result).toEqual({
      snapshot: { views: 15, likes: 3, comments: 1, shares: 2 },
      unavailable: ['watch_time', 'avg_watch_pct'],
    });
  });

  it('treats a missing elements array as zero for that metric', async () => {
    const fake = fakeFetch(json({}), json({}), json({}), json({}));
    const fetcher = createLinkedInMetrics({ fetchImpl: fake.fetch, enabled: true });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'urn:li:share:1' }));

    expect(result.snapshot).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  it('treats an element with no count as zero within the sum', async () => {
    const fake = fakeFetch(json({ elements: [{ count: 4 }, {}] }), json({}), json({}), json({}));
    const fetcher = createLinkedInMetrics({ fetchImpl: fake.fetch, enabled: true });

    const result = await fetcher.fetch(baseRequest({ platformPostId: 'urn:li:share:2' }));

    expect(result.snapshot.views).toBe(4);
  });

  it('has the linkedin_video platform id', () => {
    const fetcher = createLinkedInMetrics({ fetchImpl: fakeFetch().fetch, enabled: true });
    expect(fetcher.platform).toBe('linkedin_video');
  });
});

// ---------------------------------------------------------------- registry

describe('createMetricsRegistry', () => {
  it('registers a fetcher for every metrics-capable platform', () => {
    const registry = createMetricsRegistry({ fetchImpl: fakeFetch().fetch, linkedInEnabled: true });

    expect(Object.keys(registry).sort()).toEqual(
      [
        'tiktok',
        'youtube',
        'youtube_short',
        'x',
        'linkedin_video',
        'instagram_reel',
        'facebook',
      ].sort(),
    );
  });

  it('gives the youtube entry the youtube platform id (not youtube_short)', () => {
    const registry = createMetricsRegistry({ fetchImpl: fakeFetch().fetch, linkedInEnabled: true });

    expect(registry.youtube?.platform).toBe('youtube');
    expect(registry.youtube_short?.platform).toBe('youtube_short');
  });

  it('wires linkedInEnabled through to the LinkedIn fetcher', async () => {
    const registry = createMetricsRegistry({
      fetchImpl: fakeFetch().fetch,
      linkedInEnabled: false,
    });

    await expect(
      registry.linkedin_video?.fetch(baseRequest({ platformPostId: 'urn:li:share:1' })),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
