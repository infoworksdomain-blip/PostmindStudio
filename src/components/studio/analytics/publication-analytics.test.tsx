// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import {
  ageBreakdown,
  genderBreakdown,
  midpointRetention,
  PublicationAnalytics,
} from './publication-analytics';
import type { PublicationAnalyticsResponse } from './types';

afterEach(() => vi.unstubAllGlobals());

const point = (at: string, views: number) => ({
  at,
  views,
  watchTimeSec: views * 30,
  likes: 10,
  comments: 2,
  shares: 3,
  saves: 1,
});

function body(over: Partial<PublicationAnalyticsResponse> = {}) {
  return {
    publication: {
      id: 'pub_1',
      platform: 'youtube',
      platformUrl: 'https://youtube.test/watch?v=1',
      publishedAt: '2026-09-20T08:00:00.000Z',
      state: 'PUBLISHED',
    },
    latest: {
      ...point('2026-09-27T08:00:00.000Z', 4200),
      uniqueViewers: null,
      avgWatchTimePct: 0.63,
      clicks: 0,
    },
    hourly: [],
    daily: [point('2026-09-21T00:00:00.000Z', 1000), point('2026-09-22T00:00:00.000Z', 2500)],
    retention: [
      { atPct: 0.01, watchingPct: 1.02 },
      { atPct: 0.5, watchingPct: 0.61 },
      { atPct: 1, watchingPct: 0.42 },
    ],
    demographics: [
      { ageGroup: '25-34', gender: 'female', pct: 30 },
      { ageGroup: '25-34', gender: 'male', pct: 20 },
      { ageGroup: '18-24', gender: 'female', pct: 50 },
    ],
    ...over,
  };
}

describe('breakdown helpers', () => {
  it('sums demographics by age and by gender', () => {
    const slices = body().demographics;
    expect(ageBreakdown(slices)).toEqual([
      { ageGroup: '18-24', pct: 50 },
      { ageGroup: '25-34', pct: 50 },
    ]);
    expect(genderBreakdown(slices)).toEqual([
      { gender: 'female', pct: 80 },
      { gender: 'male', pct: 20 },
    ]);
    expect(midpointRetention(body().retention)).toBe(0.61);
    expect(midpointRetention([{ atPct: 0.1, watchingPct: 1 }])).toBeNull();
  });
});

describe('PublicationAnalytics', () => {
  it('shows totals, views over time, retention and audience', async () => {
    const api = mockFetch(() => ok(body()));
    renderScreen(<PublicationAnalytics publicationId="pub_1" />);
    expect(await screen.findByRole('heading', { name: 'YouTube post' })).toBeInTheDocument();
    expect(api.requests[0]?.url.pathname).toBe('/api/studio/analytics/publications/pub_1');
    expect(screen.getByText('4.2k')).toBeInTheDocument();
    expect(screen.getByText('63%')).toBeInTheDocument();
    expect(screen.getByText('61% of viewers still watching halfway through')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Viewers still watching, by how far into the video/ }),
    ).toBeInTheDocument();
    const ages = screen.getByRole('list', { name: 'Viewers by age group' });
    expect(within(ages).getAllByRole('listitem')[0]).toHaveTextContent('18-24');
    const genders = screen.getByRole('list', { name: 'Viewers by gender' });
    expect(within(genders).getAllByRole('listitem')[0]).toHaveTextContent('Female');
    expect(screen.getByRole('link', { name: /Open on YouTube/ })).toHaveAttribute(
      'href',
      'https://youtube.test/watch?v=1',
    );
    expect(screen.getByRole('link', { name: /All analytics/ })).toHaveAttribute(
      'href',
      '/analytics',
    );
  });

  it('explains missing retention and audience per platform', async () => {
    mockFetch(() => ok(body({ retention: [], demographics: [] })));
    const { unmount } = renderScreen(<PublicationAnalytics publicationId="pub_1" />);
    expect(await screen.findByText(/YouTube reports retention about a day/)).toBeInTheDocument();
    expect(screen.getByText(/YouTube shows audience data once/)).toBeInTheDocument();
    unmount();
    mockFetch(() =>
      ok(
        body({
          publication: { ...body().publication, platform: 'tiktok' },
          retention: [],
          demographics: [],
          daily: [],
        }),
      ),
    );
    renderScreen(<PublicationAnalytics publicationId="pub_1" />);
    expect(
      await screen.findByText('TikTok does not report a retention curve.'),
    ).toBeInTheDocument();
    expect(screen.getByText('TikTok does not report audience demographics.')).toBeInTheDocument();
    expect(screen.getByText('A daily chart appears after the second day.')).toBeInTheDocument();
  });

  it('shows the empty and error states', async () => {
    mockFetch(() => ok(body({ latest: null })));
    const { unmount } = renderScreen(<PublicationAnalytics publicationId="pub_1" />);
    expect(await screen.findByText('No numbers yet')).toBeInTheDocument();
    unmount();
    mockFetch(() => fail(404, 'Publication not found', 'not_found'));
    renderScreen(<PublicationAnalytics publicationId="pub_x" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Publication not found');
  });
});
