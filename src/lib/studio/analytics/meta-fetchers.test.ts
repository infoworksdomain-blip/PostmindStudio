import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import { PlatformError } from '../../errors';
import {
  countOrSum,
  createFacebookMetrics,
  createInstagramMetrics,
  readInsights,
  type FetchMetricsRequest,
} from './fetchers';

// Fixtures follow the InsightsResult shape in Meta's references (read 2026-09-27):
//   https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
//   https://developers.facebook.com/docs/graph-api/reference/video/video_insights/
// { data: [{ name, period, values: [{ value }], title, description, id }] }

const request = (overrides: Partial<FetchMetricsRequest> = {}): FetchMetricsRequest => ({
  accessToken: 'EAAG-page-token',
  accountId: '17841400000000001',
  platformPostId: '17900000000000001',
  publishedAt: new Date('2026-09-20T00:00:00Z'),
  now: Date.parse('2026-09-27T12:00:00Z'),
  ...overrides,
});

const node = (name: string, value: unknown) => ({
  name,
  period: 'lifetime',
  values: [{ value }],
  title: name,
  description: `${name} description`,
  id: `17900000000000001/insights/${name}/lifetime`,
});

const IG_REEL_INSIGHTS = {
  data: [
    node('views', 1520),
    node('reach', 980),
    node('likes', 64),
    node('comments', 7),
    node('shares', 12),
    node('saved', 9),
  ],
};

describe('readInsights / countOrSum', () => {
  it('reads values[0].value, falls back to total_value, and skips nameless or null nodes', () => {
    const m = readInsights([
      node('views', 3),
      { name: 'reach', total_value: { value: 2 } },
      { values: [{ value: 9 }] },
      node('likes', null),
    ]);
    expect([...m.entries()]).toEqual([
      ['views', 3],
      ['reach', 2],
    ]);
    expect(readInsights(undefined).size).toBe(0);
  });

  it('sums an all-numeric by-type object and refuses anything else', () => {
    expect(countOrSum(5)).toBe(5);
    expect(countOrSum({ REACTION_LIKE: 4, REACTION_LOVE: 2 })).toBe(6);
    expect(countOrSum({ like: 1, other: 'x' })).toBeUndefined();
    expect(countOrSum({})).toBeUndefined();
    expect(countOrSum('7')).toBeUndefined();
    expect(countOrSum([1, 2])).toBeUndefined();
  });
});

describe('createInstagramMetrics', () => {
  it('requests the documented REELS metrics and maps them into a snapshot', async () => {
    const fake = fakeFetch(json(IG_REEL_INSIGHTS));
    const result = await createInstagramMetrics({ fetchImpl: fake.fetch }).fetch(request());

    const url = new URL(fake.requests[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://graph.facebook.com/v26.0/17900000000000001/insights',
    );
    expect(url.searchParams.get('metric')).toBe('views,reach,likes,comments,shares,saved');
    expect(url.searchParams.get('access_token')).toBe('EAAG-page-token');
    expect(fake.requests[0]?.method).toBe('GET');
    expect(result.snapshot).toEqual({
      views: 1520,
      uniqueViewers: 980,
      likes: 64,
      comments: 7,
      shares: 12,
      saves: 9,
    });
    // Watch time: the reference does not state the unit, so it is never read.
    expect(result.unavailable).toEqual(['watch_time', 'avg_watch_pct']);
    expect(result.snapshot.watchTimeSec).toBeUndefined();
  });

  it('honours a configured Graph version', async () => {
    const fake = fakeFetch(json(IG_REEL_INSIGHTS));
    await createInstagramMetrics({ fetchImpl: fake.fetch, graphVersion: 'v27.0' }).fetch(request());
    expect(fake.requests[0]?.url).toContain('/v27.0/17900000000000001/insights');
  });

  it('lists metrics Meta left out ("an empty data set instead of 0") as unavailable', async () => {
    const fake = fakeFetch(json({ data: [node('views', 40)] }));
    const result = await createInstagramMetrics({ fetchImpl: fake.fetch }).fetch(request());
    expect(result.snapshot).toMatchObject({ views: 40, likes: 0, uniqueViewers: null });
    expect(result.unavailable).toEqual([
      'watch_time',
      'avg_watch_pct',
      'reach',
      'likes',
      'comments',
      'shares',
      'saved',
    ]);
  });

  it('turns Graph error 190 into needs_reconnect and 4 / 17 / 32 / 613 into rate_limited', async () => {
    const expired = fakeFetch(
      json({ error: { message: 'Session has expired', code: 190, error_subcode: 463 } }, 400),
    );
    await expect(
      createInstagramMetrics({ fetchImpl: expired.fetch }).fetch(request()),
    ).rejects.toMatchObject({ platform: 'instagram', errorClass: 'needs_reconnect' });

    const limited = fakeFetch(json({ error: { message: 'Too many calls', code: 4 } }, 400));
    await expect(
      createInstagramMetrics({ fetchImpl: limited.fetch }).fetch(request()),
    ).rejects.toMatchObject({ errorClass: 'rate_limited', retryable: true });
  });
});

describe('createFacebookMetrics', () => {
  it('requests the documented Reels metrics from /video_insights and converts ms to s', async () => {
    const fake = fakeFetch(
      json({
        data: [
          node('fb_reels_total_plays', 2400),
          node('post_impressions_unique', 1800),
          node('post_video_view_time', 3_600_500),
          node('post_video_likes_by_reaction_type', { REACTION_LIKE: 30, REACTION_LOVE: 5 }),
        ],
      }),
    );
    const result = await createFacebookMetrics({ fetchImpl: fake.fetch }).fetch(
      request({ platformPostId: '1234567890123456' }),
    );
    const url = new URL(fake.requests[0]?.url ?? '');
    expect(url.pathname).toBe('/v26.0/1234567890123456/video_insights');
    expect(url.searchParams.get('metric')).toBe(
      'fb_reels_total_plays,post_impressions_unique,post_video_view_time,post_video_likes_by_reaction_type',
    );
    expect(result.snapshot).toEqual({
      views: 2400,
      uniqueViewers: 1800,
      watchTimeSec: 3601,
      likes: 35,
      comments: 0,
      shares: 0,
    });
    // post_video_social_actions combines comments and shares, so neither is claimed.
    expect(result.unavailable).toEqual(['avg_watch_pct', 'comments', 'shares']);
  });

  it('accepts a plain number for likes and reports missing metrics as unavailable', async () => {
    const fake = fakeFetch(json({ data: [node('post_video_likes_by_reaction_type', 3)] }));
    const result = await createFacebookMetrics({ fetchImpl: fake.fetch }).fetch(request());
    expect(result.snapshot).toEqual({
      views: 0,
      uniqueViewers: null,
      likes: 3,
      comments: 0,
      shares: 0,
    });
    expect(result.unavailable).toEqual([
      'avg_watch_pct',
      'comments',
      'shares',
      'views',
      'unique_viewers',
      'watch_time',
    ]);
  });

  it('maps an expired Page token to needs_reconnect', async () => {
    const fake = fakeFetch(
      json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400),
    );
    const err = await createFacebookMetrics({ fetchImpl: fake.fetch })
      .fetch(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ platform: 'facebook', errorClass: 'needs_reconnect' });
  });
});
