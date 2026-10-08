import type { ReactElement } from 'react';
import { BusinessProvider } from '../business-context';
import { renderWithSWR, type MockRoute } from '../library/test-helpers';
import { AnalyticsDashboard } from './analytics-dashboard';
import type {
  BestTimesResponse,
  CostResponse,
  LeaderboardResponse,
  OverviewResponse,
} from './types';

// Shared fixtures for the analytics dashboard tests (25.11): API bodies, routes and a renderer
// inside the BusinessProvider. Test-only.

export const overview: OverviewResponse = {
  ok: true,
  days: 30,
  publications: 3,
  projectsCreated: 2,
  totals: { views: 12_400, watchTimeSec: 3_725, likes: 300, comments: 40, shares: 50, saves: 10 },
  byPlatform: {
    tiktok: { publications: 2, views: 10_000, engagement: 350 },
    youtube_short: { publications: 1, views: 2_400, engagement: 50 },
  },
};

export const leaderboard: LeaderboardResponse = {
  ok: true,
  metric: 'views',
  data: [
    {
      id: 'pub_1',
      renderId: 'render_1',
      platform: 'tiktok',
      platformUrl: 'https://tiktok.test/v/1',
      publishedAt: '2026-09-20T10:00:00.000Z',
      projectId: 'proj_1',
      caption: 'Latte art in 10s',
      value: 9_000,
    },
  ],
};

export const cost: CostResponse = {
  ok: true,
  days: 30,
  totalPence: 1_234,
  byProvider: [{ provider: 'runway', costPence: 1_000, jobs: 4 }],
  byProject: [
    { projectId: 'proj_1', name: 'Spring offer', costPence: 900 },
    { projectId: null, name: null, costPence: 334 },
  ],
  byDay: [{ day: '2026-09-26', costPence: 1_234 }],
};

export const bestTimes: BestTimesResponse = {
  ok: true,
  data: [
    { weekday: 2, hour: 8, score: 1, basis: '6 videos' },
    { weekday: 4, hour: 18, score: 0.82, basis: '5 videos' },
  ],
  bestPerDay: [],
  sufficientData: true,
  videos: 14,
  minVideos: 8,
  timezone: 'Europe/London',
  styleMemory: null,
};

/** A daily series of 2 × days: `previous` per day, then `current` per day (last day = `last`). */
export function series(days: number, previous: number, current: number, extra: object = {}) {
  return {
    ok: true,
    metric: 'views',
    data: Array.from({ length: days * 2 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
      value: i < days ? previous : current,
      ...(i === days * 2 - 1 ? extra : {}),
    })),
  };
}

export const me = (platformRole: string): MockRoute => ({
  match: /\/api\/studio\/me$/,
  body: { ok: true, me: { capabilities: [], user: { platformRole } } },
});

// Spend is staff-only (operator decision 2026-10-04): these tests view the page as staff unless they
// pass a customer /me first (the first matching route wins).
export function routes(over: MockRoute[] = []): MockRoute[] {
  return [
    ...over,
    me('staff'),
    { match: '/analytics/overview', body: overview },
    { match: /\/analytics\/timeseries\?days=14&/, body: series(7, 10, 15) },
    { match: /\/analytics\/timeseries\?days=60&/, body: series(30, 10, 20) },
    { match: /\/analytics\/timeseries\?days=180&/, body: series(90, 0, 5) },
    { match: '/analytics/leaderboard', body: leaderboard },
    { match: '/analytics/best-times', body: bestTimes },
    { match: '/analytics/cost', body: cost },
    { match: '/renders/render_1', body: { ok: true, render: { thumbnailUrl: null } } },
    {
      match: /\/api\/studio\/businesses$/,
      body: { ok: true, data: [{ id: 'biz_1', name: 'Leeds Sourdough' }], local: true },
    },
  ];
}

export function renderPage(ui: ReactElement = <AnalyticsDashboard />, business?: string) {
  return renderWithSWR(<BusinessProvider initial={business}>{ui}</BusinessProvider>);
}
