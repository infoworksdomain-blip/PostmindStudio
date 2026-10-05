// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { AnalyticsDashboard } from './analytics-dashboard';
import type { CostResponse, LeaderboardResponse, OverviewResponse } from './types';

const overview: OverviewResponse = {
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

const leaderboard: LeaderboardResponse = {
  ok: true,
  metric: 'views',
  data: [
    {
      id: 'pub_1',
      platform: 'tiktok',
      platformUrl: 'https://tiktok.test/v/1',
      publishedAt: '2026-09-20T10:00:00.000Z',
      projectId: 'proj_1',
      caption: 'Latte art in 10s',
      value: 9_000,
    },
  ],
};

const cost: CostResponse = {
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

const me = (platformRole: string): MockRoute => ({
  match: /\/api\/studio\/me$/,
  body: { ok: true, me: { capabilities: [], user: { platformRole } } },
});

// Spend is staff-only (operator decision 2026-10-04): these tests view the page as staff unless they
// pass a customer /me first (the first matching route wins).
function routes(over: MockRoute[] = []): MockRoute[] {
  return [
    ...over,
    me('staff'),
    { match: '/analytics/overview', body: overview },
    {
      match: '/analytics/timeseries',
      body: {
        ok: true,
        metric: 'views',
        data: [
          { day: '2026-09-25', value: 100 },
          { day: '2026-09-26', value: 300 },
        ],
      },
    },
    { match: '/analytics/leaderboard', body: leaderboard },
    { match: '/analytics/cost', body: cost },
  ];
}

afterEach(() => vi.unstubAllGlobals());

describe('AnalyticsDashboard', () => {
  it('shows headline totals, engagement rate and spend', async () => {
    mockFetch(routes());
    renderWithSWR(<AnalyticsDashboard />);
    expect(await screen.findByText(/^12.4k$/i)).toBeInTheDocument();
    expect(screen.getByText(/across 3 publications · 2 projects started/)).toBeInTheDocument();
    expect(screen.getByText('1h 02m')).toBeInTheDocument();
    // (300+40+50+10)/12400 = 3.2%
    expect(screen.getByText('3.2% of views')).toBeInTheDocument();
    expect(await screen.findAllByText('£12.34')).not.toHaveLength(0);
  });

  it('breaks views down by platform and ranks top videos', async () => {
    mockFetch(routes());
    renderWithSWR(<AnalyticsDashboard />);
    const platforms = await screen.findByRole('list', { name: 'Views by platform' });
    const rows = within(platforms).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('TikTok');
    expect(rows[1]).toHaveTextContent('YouTube Shorts');
    const top = await screen.findByRole('list', { name: 'Top publications' });
    expect(within(top).getByRole('link', { name: 'Latte art in 10s' })).toHaveAttribute(
      'href',
      '/projects/proj_1',
    );
    expect(within(top).getByRole('link', { name: 'Open on TikTok' })).toHaveAttribute(
      'href',
      'https://tiktok.test/v/1',
    );
    // 13.28: each row opens that publication's analytics.
    expect(
      within(top).getByRole('link', { name: 'Analytics for Latte art in 10s' }),
    ).toHaveAttribute('href', '/analytics/publications/pub_1');
  });

  it('refetches every panel when the date range changes', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AnalyticsDashboard />);
    await screen.findByText(/^12.4k$/i);
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => {
      for (const path of ['overview', 'timeseries', 'leaderboard', 'cost']) {
        expect(
          calls.some((c) => c.url.includes(`/analytics/${path}`) && c.url.includes('days=7')),
        ).toBe(true);
      }
    });
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
  });

  it('switches the trend metric', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AnalyticsDashboard />);
    await screen.findByText(/^12.4k$/i);
    await user.click(screen.getByRole('radio', { name: 'Engagement' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.includes('/analytics/timeseries') && c.url.includes('metric=engagement'),
        ),
      ).toBe(true),
    );
  });

  it('shows spend by provider and project', async () => {
    mockFetch(routes());
    renderWithSWR(<AnalyticsDashboard />);
    const providers = await screen.findByRole('list', { name: 'Spend by provider' });
    expect(providers).toHaveTextContent('runway');
    expect(providers).toHaveTextContent('4 jobs');
    const projects = screen.getByRole('list', { name: 'Spend by project' });
    expect(within(projects).getByRole('link', { name: 'Spring offer' })).toHaveAttribute(
      'href',
      '/projects/proj_1',
    );
    expect(projects).toHaveTextContent('Not tied to a project');
  });

  it('says when days in the trend are estimated because snapshots were missing', async () => {
    mockFetch(
      routes([
        {
          match: '/analytics/timeseries',
          body: {
            ok: true,
            metric: 'views',
            data: [
              { day: '2026-09-25', value: 100 },
              { day: '2026-09-26', value: 100, estimated: true },
            ],
          },
        },
      ]),
    );
    renderWithSWR(<AnalyticsDashboard />);
    expect(await screen.findByRole('note')).toHaveTextContent(/estimates/i);
  });

  it('shows empty breakdowns when nothing was published', async () => {
    mockFetch(
      routes([
        {
          match: '/analytics/overview',
          body: {
            ...overview,
            publications: 0,
            byPlatform: {},
            totals: { ...overview.totals, views: 0 },
          },
        },
        { match: '/analytics/leaderboard', body: { ok: true, metric: 'views', data: [] } },
      ]),
    );
    renderWithSWR(<AnalyticsDashboard />);
    expect(await screen.findAllByText('Nothing published in this window.')).toHaveLength(2);
    expect(screen.getByText('— of views')).toBeInTheDocument();
  });

  it('shows an error with retry when the overview fails', async () => {
    mockFetch(
      routes([
        {
          match: '/analytics/overview',
          status: 500,
          body: { ok: false, error: 'internal', message: 'Analytics store unavailable' },
        },
      ]),
    );
    renderWithSWR(<AnalyticsDashboard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Analytics store unavailable');
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});

describe('AnalyticsDashboard for customers (operator decision 2026-10-04)', () => {
  it('shows no spend figure, spend section or cost wording, and never asks for costs', async () => {
    const { calls } = mockFetch(routes([me('user')]));
    renderWithSWR(<AnalyticsDashboard />);
    expect(await screen.findByText(/^12.4k$/i)).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Views by platform' });
    expect(screen.getByText('3.2% of views')).toBeInTheDocument();
    expect(screen.queryByText('Spend')).not.toBeInTheDocument();
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Spend by provider' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/analytics/cost'))).toBe(false);
  });
});

describe('AnalyticsDashboard localisation', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  });

  it('renders Arabic right-to-left, with Arabic plurals and RTL arrow keys', async () => {
    const user = userEvent.setup();
    const ar = ALL_MESSAGES.ar.analytics;
    const { calls } = mockFetch(routes());
    renderWithSWR(withLocale('ar', <AnalyticsDashboard />));
    expect(
      await screen.findByRole('heading', { name: ar.dashboard.title, level: 1 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
    // 7 → the Arabic "few" form; 30 → "many".
    expect(screen.getByRole('radio', { name: '7 أيام' })).toBeInTheDocument();
    const thirty = screen.getByRole('radio', { name: '30 يومًا' });
    expect(thirty).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByRole('list', { name: ar.platforms.listLabel })).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: ar.cost.byProvider.listLabel }),
    ).toHaveTextContent('4 مهام');
    // In RTL the next option sits to the left.
    thirty.focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/analytics/cost') && c.url.includes('days=90')),
      ).toBe(true),
    );
  });

  it('renders Simplified Chinese', async () => {
    const zh = ALL_MESSAGES['zh-Hans'].analytics;
    mockFetch(routes());
    renderWithSWR(withLocale('zh-Hans', <AnalyticsDashboard />));
    expect(
      await screen.findByRole('heading', { name: zh.dashboard.title, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '7 天' })).toBeInTheDocument();
    expect(await screen.findByText('共 3 条发布 · 新建 2 个项目')).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: zh.cost.byProvider.listLabel }),
    ).toHaveTextContent('4 个任务');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans'));
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });
});
