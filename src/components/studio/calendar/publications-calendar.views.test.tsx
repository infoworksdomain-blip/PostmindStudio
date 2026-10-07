// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import { mockFetch, ok, renderScreen } from '../publications/test-utils';
import { PublicationsCalendar } from './publications-calendar';
import { setTestUrl, testUrl } from './test-navigation';

vi.mock('next/navigation', async () => (await import('./test-navigation')).navigationMock);

// BACKLOG 25.9 — Month / Week / Day views over the same /publications window API, the view and
// filters in the URL, "+n more", the month grid's keyboard model and the campaign labels.

const SEPT = new Date(2026, 8, 10);

function pub(id: string, overrides: Partial<Publication> = {}): Publication {
  return {
    id,
    projectId: `prj_${id}`,
    renderId: 'ren',
    platform: 'tiktok',
    platformAccountId: 'acc',
    state: 'SCHEDULED',
    scheduledFor: new Date(2026, 8, 16, 10, 30).toISOString(),
    publishedAt: null,
    platformPostId: null,
    platformUrl: null,
    caption: null,
    hashtags: [],
    errorReason: null,
    errorCode: null,
    retryCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    project: { id: `prj_${id}`, name: `Video ${id}` },
    ...overrides,
  };
}

const POSTS = [
  pub('a', {
    campaign: { kind: 'plan', planId: 'plan_1', startDate: '2026-09-01', days: 30 },
  }),
  pub('b', {
    platform: 'x',
    state: 'FAILED',
    campaign: { kind: 'automation', planId: 'plan_2', automationId: 'au', name: 'Weekly tips' },
  }),
  pub('c', { scheduledFor: new Date(2026, 8, 17, 9).toISOString() }),
];

function server(data: Publication[] = POSTS) {
  return mockFetch((req) => {
    if (req.url.pathname.endsWith('/publications')) return ok({ data, nextCursor: null });
    if (req.url.pathname.endsWith('/projects/prj_a/preview'))
      return ok({
        preview: {
          media: {
            kind: 'video',
            url: 'https://cdn.test/a.mp4',
            posterUrl: 'https://cdn.test/a.jpg',
            durationSec: 8,
          },
        },
      });
    if (req.url.pathname.endsWith('/preview')) return { status: 404, body: { ok: false } };
    return undefined;
  });
}

beforeEach(() => setTestUrl('/calendar'));
afterEach(() => vi.unstubAllGlobals());

describe('PublicationsCalendar views (25.9)', () => {
  it('switches to the week view: the URL, the request window and seven day columns', async () => {
    const api = server();
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={new Date(2026, 8, 16)} />);
    await screen.findByRole('grid', { name: 'Days of the month' });
    await user.click(screen.getByRole('radio', { name: 'Week' }));
    expect(testUrl().searchParams.get('view')).toBe('week');
    const week = await screen.findByRole('list', { name: 'Days of the week' });
    expect(week.querySelectorAll('[data-day]')).toHaveLength(7);
    expect(screen.getByRole('heading', { name: /14.+20 Sept 2026/ })).toBeInTheDocument();
    await waitFor(() => {
      const last = api.find('GET', '/publications').at(-1)!.url.searchParams;
      expect(new Date(last.get('from')!).getTime()).toBe(new Date(2026, 8, 14).getTime());
      expect(new Date(last.get('to')!).getTime()).toBe(new Date(2026, 8, 21).getTime());
    });
    // Posts carry their campaign and a thumbnail slot.
    const cell = week.querySelector('[data-day="2026-09-16"]') as HTMLElement;
    expect(within(cell).getByText('Month plan · 1 Sept')).toBeInTheDocument();
    // The thumbnail comes lazily from the post preview (only posts that have one show it).
    await waitFor(() =>
      expect(cell.querySelector('[data-post-thumb="image"] img')).toHaveAttribute(
        'src',
        'https://cdn.test/a.jpg',
      ),
    );
    // Next week moves the anchor by seven days.
    await user.click(screen.getByRole('button', { name: 'Next week' }));
    expect(testUrl().searchParams.get('date')).toBe('2026-09-23');
  });

  it('opens a day from the month grid (its date) and lists that day only', async () => {
    server();
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    const cell = grid.querySelector('[data-day="2026-09-17"]') as HTMLElement;
    cell.focus();
    await user.keyboard('{Enter}');
    expect(testUrl().searchParams.get('view')).toBe('day');
    expect(testUrl().searchParams.get('date')).toBe('2026-09-17');
    const day = await screen.findByRole('list', { name: 'Posts on this day' });
    expect(within(day).getAllByRole('button', { name: /^Video c, TikTok/ })).toHaveLength(1);
    expect(within(day).queryByRole('button', { name: /^Video a/ })).toBeNull();
  });

  it('the month grid is one tab stop: arrows move and select the day', async () => {
    server();
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(7);
    expect(within(grid).getAllByRole('row')).toHaveLength(6); // header + 5 weeks
    const focusable = grid.querySelectorAll('[role="gridcell"][tabindex="0"]');
    expect(focusable).toHaveLength(1);
    const start = grid.querySelector('[data-day="2026-09-16"]') as HTMLElement;
    start.focus();
    await user.keyboard('{ArrowRight}');
    expect(testUrl().searchParams.get('date')).toBe('2026-09-17');
    await waitFor(() =>
      expect(grid.querySelector('[data-day="2026-09-17"]')).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await waitFor(() => expect(grid.querySelector('[data-day="2026-09-17"]')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(testUrl().searchParams.get('date')).toBe('2026-09-24');
  });

  it('filters by platform, status and source in the URL and says how many show', async () => {
    server();
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    expect(within(grid).getAllByRole('button', { name: /^Video [abc],/ })).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText('Source'), 'automation');
    expect(testUrl().searchParams.get('source')).toBe('automation');
    await waitFor(() =>
      expect(within(grid).getAllByRole('button', { name: /^Video [abc],/ })).toHaveLength(1),
    );
    expect(within(grid).getByRole('button', { name: /^Video b, X, Failed/ })).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 3 posts')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Source'), '');
    await user.selectOptions(screen.getByLabelText('Platform'), 'tiktok');
    await waitFor(() =>
      expect(within(grid).getAllByRole('button', { name: /^Video [abc],/ })).toHaveLength(2),
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'FAILED');
    await waitFor(() =>
      expect(within(grid).queryAllByRole('button', { name: /^Video/ })).toHaveLength(0),
    );
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(testUrl().search).toBe('');
    await waitFor(() =>
      expect(within(grid).getAllByRole('button', { name: /^Video [abc],/ })).toHaveLength(3),
    );
  });

  it('reads the view and filters from the URL on load', async () => {
    setTestUrl('/calendar?view=day&date=2026-09-16&platform=x');
    server();
    renderScreen(<PublicationsCalendar />);
    const day = await screen.findByRole('list', { name: 'Posts on this day' });
    expect(within(day).getAllByRole('button', { name: /^Video b/ })).toHaveLength(1);
    expect(within(day).queryByRole('button', { name: /^Video a/ })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Day' })).toBeChecked();
  });

  it('"+n more" opens everything on a day that has more than fits', async () => {
    const many = [8, 9, 10, 11, 12].map((h, i) =>
      pub(`m${i}`, { scheduledFor: new Date(2026, 8, 22, h).toISOString() }),
    );
    server(many);
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    const cell = grid.querySelector('[data-day="2026-09-22"]') as HTMLElement;
    expect(within(cell).getAllByRole('button', { name: /^Video m\d,/ })).toHaveLength(4);
    await user.click(
      within(cell).getByRole('button', { name: /^Show everything on .+ \(1 more\)$/ }),
    );
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getAllByRole('button', { name: /^Video m\d,/ })).toHaveLength(5);
  });
});
