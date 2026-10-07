// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { HomeScreen, REVIEW_STATES, WORKING_STATES } from './home-screen';

// BACKLOG 25.4 — the home screen reads only existing APIs and has an empty state per section.

vi.mock('next/navigation', () => ({ usePathname: () => '/home' }));
afterEach(() => vi.unstubAllGlobals());

const project = (id: string, name: string, state: string) => ({
  id,
  name,
  state,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
});

const publication = (id: string, state: string, scheduledFor: string | null) => ({
  id,
  projectId: 'prj_1',
  renderId: 'r1',
  platform: 'tiktok',
  platformAccountId: 'acc',
  state,
  scheduledFor,
  publishedAt: null,
  platformPostId: null,
  platformUrl: null,
  caption: null,
  hashtags: [],
  errorReason: null,
  errorCode: null,
  retryCount: 0,
  createdAt: '2026-10-01T00:00:00Z',
  project: { id: 'prj_1', name: `Post ${id}` },
});

const page = (data: unknown[]) => ({ data, nextCursor: null });

function stub(opts: { empty?: boolean } = {}) {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const sooner = new Date(Date.now() + 86_400_000).toISOString();
  return mockFetch([
    {
      match: `state=${encodeURIComponent(REVIEW_STATES)}`,
      body: page(opts.empty ? [] : [project('prj_r', 'Autumn menu', 'READY_FOR_REVIEW')]),
    },
    {
      match: `state=${encodeURIComponent(WORKING_STATES)}`,
      body: page(opts.empty ? [] : [project('prj_w', 'Bread week', 'RENDERING')]),
    },
    {
      match: '/publications?state=FAILED',
      body: page(opts.empty ? [] : [publication('pub_f', 'FAILED', null)]),
    },
    {
      match: '/publications?state=SCHEDULED',
      body: page(
        opts.empty
          ? []
          : [
              publication('pub_late', 'SCHEDULED', soon),
              publication('pub_soon', 'SCHEDULED', sooner),
            ],
      ),
    },
  ]);
}

function section(name: string) {
  return screen.getByRole('region', { name });
}

describe('HomeScreen', () => {
  it('shows what needs you, what is coming up and what is in progress', async () => {
    const api = stub();
    renderWithSWR(withLocale('en-GB', <HomeScreen />));
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();

    const needs = section('Needs you');
    expect(await within(needs).findByRole('link', { name: /Autumn menu/ })).toHaveAttribute(
      'href',
      '/projects/prj_r',
    );
    expect(within(needs).getByRole('link', { name: /Post pub_f/ })).toHaveTextContent(
      'Didn’t post to TikTok',
    );

    const coming = section('Coming up');
    const rows = await within(coming).findAllByRole('link', { name: /Post pub_/ });
    // Soonest first, whatever order the API returned.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('pub_soon'),
      expect.stringContaining('pub_late'),
    ]);
    expect(within(coming).getByRole('link', { name: 'Calendar' })).toHaveAttribute(
      'href',
      '/calendar',
    );

    const progress = section('In progress');
    const bread = await within(progress).findByRole('link', { name: /Bread week/ });
    expect(bread.querySelector('[data-live-stage]')).not.toBeNull();

    // Quick create points only at pages that exist.
    expect(screen.getByRole('link', { name: /Create a post/ })).toHaveAttribute('href', '/new');
    expect(screen.getByRole('link', { name: /Plan a month/ })).toHaveAttribute(
      'href',
      '/plans/new',
    );
    expect(screen.getByRole('link', { name: 'Month plans' })).toHaveAttribute('href', '/plans');

    // The coming-up window is the next 7 days.
    const scheduled = api.calls.find((c) => c.url.includes('state=SCHEDULED'))!;
    const params = new URL(scheduled.url, 'https://x.test').searchParams;
    const span = Date.parse(params.get('to')!) - Date.parse(params.get('from')!);
    expect(span).toBe(7 * 86_400_000);
  });

  it('has an empty state for every section', async () => {
    stub({ empty: true });
    renderWithSWR(withLocale('en-GB', <HomeScreen />));
    expect(
      await within(section('Needs you')).findByText(/Nothing needs you right now/),
    ).toBeVisible();
    expect(
      await within(section('Coming up')).findByText('Nothing is scheduled for the next 7 days.'),
    ).toBeVisible();
    expect(
      await within(section('In progress')).findByText('Nothing is being made right now.'),
    ).toBeVisible();
  });
});
