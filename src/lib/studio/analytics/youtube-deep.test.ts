import { describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../../../../test/helpers/fake-fetch';
import {
  ageGroupLabel,
  createYouTubeMetrics,
  readDemographics,
  readRetention,
  YT_DEEP_MIN_AGE_MS,
} from './fetchers';

// BACKLOG 13.28 — YouTube Analytics retention (audienceWatchRatio by elapsedVideoTimeRatio) and
// demographics (viewerPercentage by ageGroup, gender). Report shapes follow
// developers.google.com/youtube/analytics/reference/reports/query: columnHeaders + rows.

const NOW = Date.parse('2026-09-27T12:00:00Z');
const stats = () =>
  json({ items: [{ statistics: { viewCount: '100', likeCount: '20', commentCount: '5' } }] });
const basic = () =>
  json({
    columnHeaders: [
      { name: 'estimatedMinutesWatched' },
      { name: 'averageViewPercentage' },
      { name: 'shares' },
    ],
    rows: [[10, 55.5, 3]],
  });
const retention = () =>
  json({
    columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
    rows: [
      [0.02, 0.95],
      [0.01, 1.02],
      [0.5, 0.61],
    ],
  });
const demographics = () =>
  json({
    columnHeaders: [{ name: 'ageGroup' }, { name: 'gender' }, { name: 'viewerPercentage' }],
    rows: [
      ['age25-34', 'female', 38.2],
      ['age65-', 'male', 0],
      ['age18-24', 'male', 12.5],
    ],
  });

const request = (ageMs: number) => ({
  accessToken: 'tok',
  accountId: 'acct',
  platformPostId: 'yt-1',
  publishedAt: new Date(NOW - ageMs),
  now: NOW,
});

describe('report readers', () => {
  it('reads the retention curve in video order', () => {
    const body = {
      columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }],
      rows: [
        [0.5, 0.6],
        [0.01, 1],
        ['x', 1],
      ],
    };
    expect(readRetention(body)).toEqual([
      { atPct: 0.01, watchingPct: 1 },
      { atPct: 0.5, watchingPct: 0.6 },
    ]);
    expect(readRetention({ columnHeaders: [{ name: 'views' }], rows: [[1]] })).toEqual([]);
  });

  it('reads demographics, drops empty slices and labels age groups', () => {
    expect(
      readDemographics({
        columnHeaders: [{ name: 'ageGroup' }, { name: 'gender' }, { name: 'viewerPercentage' }],
        rows: [
          ['age18-24', 'male', 12.5],
          ['age25-34', 'female', 38.2],
          ['age65-', 'male', 0],
        ],
      }),
    ).toEqual([
      { ageGroup: '25-34', gender: 'female', pct: 38.2 },
      { ageGroup: '18-24', gender: 'male', pct: 12.5 },
    ]);
    expect(readDemographics({})).toEqual([]);
    expect(ageGroupLabel('age65-')).toBe('65+');
    expect(ageGroupLabel('age13-17')).toBe('13-17');
    expect(ageGroupLabel('unknown')).toBe('unknown');
  });
});

describe('createYouTubeMetrics retention and demographics', () => {
  it('reads both reports once a video is a day old', async () => {
    const fake = fakeFetch(stats(), basic(), retention(), demographics());
    const result = await createYouTubeMetrics({ fetchImpl: fake.fetch }).fetch(
      request(YT_DEEP_MIN_AGE_MS),
    );
    const retentionUrl = new URL(fake.requests[2]!.url);
    expect(retentionUrl.searchParams.get('dimensions')).toBe('elapsedVideoTimeRatio');
    expect(retentionUrl.searchParams.get('metrics')).toBe('audienceWatchRatio');
    expect(retentionUrl.searchParams.get('filters')).toBe('video==yt-1');
    expect(retentionUrl.searchParams.get('ids')).toBe('channel==MINE');
    const demoUrl = new URL(fake.requests[3]!.url);
    expect(demoUrl.searchParams.get('dimensions')).toBe('ageGroup,gender');
    expect(demoUrl.searchParams.get('metrics')).toBe('viewerPercentage');
    expect(result.snapshot.retentionCurve).toEqual([
      { atPct: 0.01, watchingPct: 1.02 },
      { atPct: 0.02, watchingPct: 0.95 },
      { atPct: 0.5, watchingPct: 0.61 },
    ]);
    expect(result.snapshot.demographics).toEqual([
      { ageGroup: '25-34', gender: 'female', pct: 38.2 },
      { ageGroup: '18-24', gender: 'male', pct: 12.5 },
    ]);
    expect(result.unavailable).toEqual([]);
  });

  it('skips the reports for new videos', async () => {
    const fake = fakeFetch(stats(), basic());
    const result = await createYouTubeMetrics({ fetchImpl: fake.fetch }).fetch(
      request(YT_DEEP_MIN_AGE_MS - 1),
    );
    expect(fake.requests).toHaveLength(2);
    expect(result.snapshot).not.toHaveProperty('retentionCurve');
  });

  it('lists a refused report as unavailable and keeps the other', async () => {
    const fake = fakeFetch(
      stats(),
      basic(),
      json({ error: { message: 'forbidden' } }, 403),
      json({ columnHeaders: [{ name: 'ageGroup' }], rows: [] }),
    );
    const result = await createYouTubeMetrics({ fetchImpl: fake.fetch }).fetch(
      request(2 * YT_DEEP_MIN_AGE_MS),
    );
    expect(result.unavailable).toEqual(['retention']);
    expect(result.snapshot).not.toHaveProperty('retentionCurve');
    expect(result.snapshot).not.toHaveProperty('demographics');

    const both = fakeFetch(stats(), basic(), retention(), json({ error: {} }, 403));
    const r2 = await createYouTubeMetrics({ fetchImpl: both.fetch }).fetch(
      request(2 * YT_DEEP_MIN_AGE_MS),
    );
    expect(r2.unavailable).toEqual(['demographics']);
    expect(r2.snapshot.retentionCurve).toHaveLength(3);
  });

  it('treats network failures on the extra reports as unavailable, not fatal', async () => {
    const fake = fakeFetch(stats(), basic(), new Error('reset'), new Error('reset'));
    const result = await createYouTubeMetrics({ fetchImpl: fake.fetch }).fetch(
      request(2 * YT_DEEP_MIN_AGE_MS),
    );
    expect(result.unavailable).toEqual(['retention', 'demographics']);
    expect(result.snapshot.views).toBe(100);
  });
});
