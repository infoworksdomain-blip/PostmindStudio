// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../library/test-helpers';
import { AnalyticsDashboard } from './analytics-dashboard';
import { overview, renderPage, routes, series } from './analytics-test-fixtures';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => {
  nav.search = '';
  nav.replace.mockReset();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('AnalyticsDashboard', () => {
  it('opens with a one-sentence summary and four headline numbers', async () => {
    mockFetch(routes());
    renderPage();
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(summary).toHaveTextContent(
      'Your 3 posts from the last 30 days reached 12.4k views, with 3.2% engagement.',
    );
    expect(summary).toHaveTextContent('TikTok brought in 81% of the views.');
    const numbers = within(summary).getAllByRole('definition');
    expect(numbers.map((n) => n.textContent)).toEqual(
      expect.arrayContaining(['12.4k', '1h 02m', '3.2%', '60']),
    );
    expect(summary).toHaveTextContent('3 posts · 2 projects started');
    expect(summary).toHaveTextContent('400 likes, comments, shares and saves');
    expect(summary).toHaveTextContent('50 shares · 10 saves');
    // 3,725 s over 12,400 views is under a second a view: no "0s per view" hint.
    expect(summary).not.toHaveTextContent('per view');
  });

  it('compares growth and engagement with the previous period', async () => {
    mockFetch(routes());
    renderPage();
    // 30 days at 20 a day against 30 at 10: +100 %.
    expect(await screen.findByText('600 views gained in this period')).toBeInTheDocument();
    const badges = await screen.findAllByText(/on the previous period/);
    expect(badges[0]).toHaveTextContent('Up 100% on the previous period');
    expect(screen.getByRole('img', { name: /Views per day, last 30 days/ })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Interactions per day, last 30 days/ }),
    ).toBeInTheDocument();
    const mix = screen.getByRole('list', { name: 'Engagement by type' });
    expect(within(mix).getAllByRole('listitem')[0]).toHaveTextContent('Likes300');
  });

  it('asks for twice the window so the change is computed, and switches the trend metric', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderPage();
    await screen.findByRole('region', { name: 'Summary' });
    await user.click(screen.getByRole('radio', { name: 'Watch time' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/analytics/timeseries') &&
            c.url.includes('days=60') &&
            c.url.includes('metric=watchTime'),
        ),
      ).toBe(true),
    );
  });

  it('ranks top posts with thumbnails, each opening its own analytics', async () => {
    const { calls } = mockFetch(routes());
    renderPage();
    const top = await screen.findByRole('list', { name: 'Top publications' });
    expect(
      within(top).getByRole('link', { name: 'Analytics for Latte art in 10s' }),
    ).toHaveAttribute('href', '/analytics/publications/pub_1');
    expect(within(top).getByRole('link', { name: 'Open on TikTok' })).toHaveAttribute(
      'href',
      'https://tiktok.test/v/1',
    );
    await waitFor(() => expect(calls.some((c) => c.url.includes('/renders/render_1'))).toBe(true));
    const platforms = screen.getByRole('list', { name: 'Views by platform' });
    const rows = within(platforms).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('TikTok');
    expect(rows[1]).toHaveTextContent('YouTube Shorts');
  });

  it('shows the best posting times with what they are based on', async () => {
    mockFetch(routes());
    renderPage();
    const list = await screen.findByRole('list', { name: 'Best posting times' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Tuesday');
    expect(rows[0]).toHaveTextContent('100%');
    expect(rows[1]).toHaveTextContent('82%');
    expect(screen.getByText(/Based on 14 posts from the last 180 days/)).toBeInTheDocument();
  });

  it('keeps the period in the URL and refetches every panel', async () => {
    const user = userEvent.setup();
    nav.search = 'days=7';
    const { calls } = mockFetch(routes());
    renderPage();
    expect(await screen.findByRole('radio', { name: '7 days' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await waitFor(() => {
      for (const path of [
        'overview?days=7',
        'timeseries?days=14',
        'leaderboard?days=7',
        'cost?days=7',
      ])
        expect(calls.some((c) => c.url.includes(`/analytics/${path}`))).toBe(true);
    });
    await user.click(screen.getByRole('radio', { name: '90 days' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/analytics?days=90', { scroll: false });
    expect(screen.getByRole('radio', { name: '90 days' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/analytics/overview?days=90'))).toBe(true),
    );
    await user.click(screen.getByRole('radio', { name: '30 days' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/analytics', { scroll: false });
  });

  it('narrows every customer-facing panel to the selected business', async () => {
    const { calls } = mockFetch(routes());
    renderPage(<AnalyticsDashboard />, 'biz_1');
    expect(await screen.findByText('Leeds Sourdough')).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Best posting times' });
    for (const path of ['overview', 'timeseries', 'leaderboard', 'best-times'])
      expect(
        calls.some(
          (c) => c.url.includes(`/analytics/${path}`) && c.url.includes('businessId=biz_1'),
        ),
      ).toBe(true);
    // Spend stays organisation-wide, and says so.
    expect(
      calls
        .filter((c) => c.url.includes('/analytics/cost'))
        .every((c) => !c.url.includes('businessId')),
    ).toBe(true);
    expect(
      await screen.findByText('Spend covers every business in your organisation.'),
    ).toBeInTheDocument();
  });

  it('says "All businesses" and sends no business filter when none is selected', async () => {
    const { calls } = mockFetch(routes());
    renderPage();
    expect(await screen.findByText('All businesses')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Summary' });
    expect(calls.some((c) => c.url.includes('businessId='))).toBe(false);
    expect(screen.queryByText(/Spend covers every business/)).not.toBeInTheDocument();
  });

  it('shows spend by provider and project for staff', async () => {
    mockFetch(routes());
    renderPage();
    const providers = await screen.findByRole('list', { name: 'Spend by provider' });
    expect(providers).toHaveTextContent('runway');
    expect(providers).toHaveTextContent('4 jobs');
    expect(screen.getAllByText(/£12\.34/).length).toBeGreaterThan(0);
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
          match: /\/analytics\/timeseries\?days=60&metric=views/,
          body: series(30, 10, 20, { estimated: true }),
        },
      ]),
    );
    renderPage();
    expect(await screen.findByRole('note')).toHaveTextContent(/estimates/i);
  });

  it('explains an empty period instead of showing zeros', async () => {
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
        { match: /\/analytics\/timeseries/, body: series(30, 0, 0) },
      ]),
    );
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'No posts published in the last 30 days' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(await screen.findAllByText('Nothing published in this window.')).toHaveLength(2);
    expect(
      screen.getByText(
        'Nothing new in this period yet. The chart fills in as people watch your posts.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/on the previous period/)).not.toBeInTheDocument();
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
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Analytics store unavailable');
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});
