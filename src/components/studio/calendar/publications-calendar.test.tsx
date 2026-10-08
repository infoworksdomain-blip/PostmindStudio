// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { zoneLabel } from './month';
import { PublicationsCalendar } from './publications-calendar';
import { MAX_PAGES } from './use-calendar-publications';
import type { UpcomingSlots } from './use-upcoming-slots';
import { setTestUrl } from './test-navigation';

vi.mock('next/navigation', async () => (await import('./test-navigation')).navigationMock);

function pub(id: string, overrides: Partial<Publication>): Publication {
  return {
    id,
    projectId: `prj_${id}`,
    renderId: 'ren',
    platform: 'youtube_short',
    platformAccountId: 'acc',
    state: 'SCHEDULED',
    scheduledFor: new Date(2026, 8, 14, 10, 30).toISOString(),
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

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => setTestUrl('/calendar'));

const SEPT = new Date(2026, 8, 10);

describe('PublicationsCalendar', () => {
  it('says which time zone the times are in', async () => {
    mockFetch(() => ok({ data: [], nextCursor: null }));
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const zone = zoneLabel(new Date(2026, 8, 15), 'en-GB');
    expect(
      await screen.findByText(`Times are shown in your time zone: ${zone}.`),
    ).toBeInTheDocument();
  });

  it('shows the empty-month text in the grid (desktop) as well as the agenda (phones)', async () => {
    mockFetch(() => ok({ data: [], nextCursor: null }));
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const messages = await screen.findAllByText('Nothing scheduled or published this month.');
    expect(messages).toHaveLength(2);
    const grid = screen.getByRole('grid', { name: 'Days of the month' });
    expect(grid.parentElement).toContainElement(messages[0] as HTMLElement);
  });

  it('shows a failed publication as failed and retries it from the calendar', async () => {
    const user = userEvent.setup();
    const api = mockFetch((req) => {
      if (req.method === 'POST' && req.url.pathname.endsWith('/publications/f1/retry'))
        return ok({ publication: {} });
      if (req.url.pathname.endsWith('/publications'))
        return ok({
          data: [pub('f1', { state: 'FAILED', errorReason: 'quota' })],
          nextCursor: null,
        });
      return undefined;
    });
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    expect(
      within(grid).getByRole('button', { name: /Video f1, YouTube Shorts, Failed/ }),
    ).toBeInTheDocument();
    await user.click(within(grid).getByRole('button', { name: 'Retry Video f1' }));
    await waitFor(() => expect(api.find('POST', '/publications/f1/retry')).toHaveLength(1));
  });

  it('shows all four posts of a full day in the month grid (the daily maximum)', async () => {
    mockFetch(() =>
      ok({
        data: [8, 11, 14, 17].map((h, i) =>
          pub(`d${i}`, { scheduledFor: new Date(2026, 8, 14, h, 0).toISOString() }),
        ),
        nextCursor: null,
      }),
    );
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    const cell = grid.querySelector('[data-day="2026-09-14"]') as HTMLElement;
    expect(
      within(cell).getAllByRole('button', { name: /^Video d\d, YouTube Shorts/ }),
    ).toHaveLength(4);
    expect(within(cell).queryByText(/more/)).toBeNull();
  });

  it('requests the visible window with calendar states and places events on their day', async () => {
    const api = mockFetch(() =>
      ok({
        data: [
          pub('a', {}),
          pub('b', {
            state: 'PUBLISHED',
            scheduledFor: null,
            publishedAt: new Date(2026, 8, 20, 18).toISOString(),
          }),
        ],
        nextCursor: null,
      }),
    );
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    expect(screen.getByLabelText('Loading calendar')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /September 2026/ })).toBeInTheDocument();

    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    // 24.2: a post opens the side panel (a dialog) instead of navigating away.
    expect(
      within(grid).getByRole('button', { name: /Video a, YouTube Shorts, Scheduled/ }),
    ).toHaveAttribute('aria-haspopup', 'dialog');
    expect(
      within(grid).getByRole('button', { name: /Video b, YouTube Shorts, Live/ }),
    ).toBeInTheDocument();
    // the phone agenda lists the same two days
    const agenda = screen.getByRole('list', { name: 'Agenda' });
    expect(
      within(agenda).getAllByRole('button', { name: /^Video [ab], YouTube Shorts/ }),
    ).toHaveLength(2);

    const q = api.find('GET', '/publications')[0]!.url.searchParams;
    expect(q.get('state')).toBe('SCHEDULED,PUBLISHING,PUBLISHED,FAILED');
    expect(new Date(q.get('from')!).getTime()).toBe(new Date(2026, 7, 31).getTime());
    expect(new Date(q.get('to')!).getTime()).toBe(new Date(2026, 9, 5).getTime());
  });

  it('moves between months', async () => {
    const api = mockFetch(() => ok({ data: [], nextCursor: null }));
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    await screen.findAllByText('Nothing scheduled or published this month.');
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeInTheDocument();
    await waitFor(() => expect(api.find('GET', '/publications')).toHaveLength(2));
    expect(
      new Date(api.find('GET', '/publications')[1]!.url.searchParams.get('from')!).getTime(),
    ).toBe(new Date(2026, 8, 28).getTime());
  });

  it('follows the cursor but stops after MAX_PAGES pages', async () => {
    let n = 0;
    const api = mockFetch((req) => {
      // 15.A5: the drip queue panel's own GET is not a calendar page.
      if (req.url.pathname.includes('drip-queue')) return undefined;
      n += 1;
      return ok({ data: [pub(`p${n}`, {})], nextCursor: `c${n}` });
    });
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    // The loading skeleton is a status too (labelled), so find the truncation notice by its text.
    expect(await screen.findByText(/Showing the first/)).toHaveAttribute('role', 'status');
    expect(api.find('GET', '/publications')).toHaveLength(MAX_PAGES);
    expect(api.find('GET', '/publications')[1]!.url.searchParams.get('cursor')).toBe('c1');
  });

  it('shows the error state', async () => {
    mockFetch(() => fail(500, 'Calendar exploded'));
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar exploded');
  });
});

describe('PublicationsCalendar — month ahead (20.3)', () => {
  const DAY = 86_400_000;
  const QUEUE = '/businesses/biz_1/drip-queue';
  const UPCOMING = `${QUEUE}/upcoming`;
  const at = (days: number, h: number, m: number) => {
    const d = new Date(Date.now() + days * DAY);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).toISOString();
  };
  const upcoming = (over: Partial<UpcomingSlots> = {}): UpcomingSlots => ({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 30 * DAY).toISOString(),
    configured: true,
    enabled: true,
    slotsPerWeek: 3,
    horizonDays: 56,
    scheduled: 2,
    openSlots: [at(2, 12, 30), at(2, 18, 0), at(3, 12, 30)],
    held: [],
    ...over,
  });
  const queue = {
    slots: [{ weekday: 1, time: '12:30', timezone: 'Europe/London' }],
    platforms: [],
    enabled: true,
    staggerMinutes: 30,
    nextSlotAt: null,
    queued: 0,
    upcoming: [],
  };

  function server(view: UpcomingSlots) {
    return mockFetch((req) => {
      const path = req.url.pathname;
      if (path.endsWith('/drip-queue/upcoming')) return ok({ upcoming: view });
      if (path.endsWith('/drip-queue'))
        return ok({
          dripQueue: req.method === 'PUT' ? { ...queue, ...(req.body as object) } : queue,
        });
      return ok({ data: [], nextCursor: null });
    });
  }

  it('shows open slots as dashed, non-link markers and a 30-day summary', async () => {
    const api = server(upcoming());
    renderScreen(<PublicationsCalendar initialDate={new Date(Date.now() + 2 * DAY)} />);
    expect(
      await screen.findByText('Next 30 days: 2 posts scheduled · 3 open slots'),
    ).toBeInTheDocument();
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    await waitFor(() => expect(within(grid).getAllByText('Open slot')).toHaveLength(3));
    expect(within(grid).queryAllByRole('link')).toHaveLength(0);
    expect(
      within(grid).getAllByText(/^Open posting time at .+, no video booked yet$/),
    ).toHaveLength(3);
    expect(screen.getByText(/Dashed boxes are open drip-queue slots/)).toBeInTheDocument();
    // Summary window: now → +30 days; the markers ask for the visible grid.
    const calls = api.find('GET', UPCOMING).map((r) => r.url.searchParams);
    const spans = calls.map((q) => Date.parse(q.get('to')!) - Date.parse(q.get('from')!));
    expect(spans).toContain(30 * DAY);
    expect(spans.every((ms) => ms <= 62 * DAY)).toBe(true);
  });

  it('20.9 / 24.2: shows month-plan posts still being made; one opens in the side panel', async () => {
    server(
      upcoming({
        openSlots: [],
        planned: [
          {
            slotAt: at(2, 9, 0),
            planId: 'plan_1',
            itemId: 'item_1',
            title: 'Halloween loaves',
            kind: 'SLIDESHOW',
            status: 'GENERATING',
          },
        ],
      }),
    );
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={new Date(Date.now() + 2 * DAY)} />);
    const grid = await screen.findByRole('grid', { name: 'Days of the month' });
    const marker = await within(grid).findByRole('button', {
      name: /^Month-plan post at .+: Halloween loaves \(Being made\)$/,
    });
    await user.click(marker);
    const panel = await screen.findByRole('dialog', { name: 'Halloween loaves' });
    expect(within(panel).getByRole('link', { name: /Open the plan/ })).toHaveAttribute(
      'href',
      '/plans/plan_1',
    );
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(/Boxes marked “Planned” are month-plan posts/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Plan my month/ })).toHaveAttribute(
      'href',
      '/plans/new',
    );
  });

  it('says the queue is off and points to the posting times', async () => {
    server(upcoming({ enabled: false, configured: false, openSlots: [], scheduled: 1 }));
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={new Date()} />);
    expect(
      await screen.findByText(/Next 30 days: 1 post scheduled\. The drip queue is off/),
    ).toBeInTheDocument();
    // 25.9: the posting times live in a side sheet now.
    await user.click(screen.getByRole('button', { name: 'set posting times' }));
    const sheet = await screen.findByRole('dialog', { name: 'Posting times' });
    expect(within(sheet).getByRole('heading', { name: 'Drip queue' })).toBeInTheDocument();
  });

  it('20.14: a posting schedule saves (turning the queue on) and refreshes the markers', async () => {
    const api = server(upcoming());
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={new Date()} />);
    await user.click(await screen.findByRole('button', { name: 'Posting times' }));
    // The saved Monday 12:30 slot reopens as a weekly schedule.
    expect(await screen.findByRole('radio', { name: 'Times a week' })).toBeChecked();
    await user.selectOptions(screen.getByLabelText('Posts a week'), '5');
    expect(screen.getAllByLabelText(/^Slot \d day$/)).toHaveLength(5);
    const before = api.find('GET', UPCOMING).length;
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.find('PUT', QUEUE)).toHaveLength(1));
    const body = api.find('PUT', QUEUE)[0]!.body as {
      slots: Array<{ weekday: number; time: string; timezone: string }>;
      schedule: { mode: string; postsPerWeek: number };
      enabled: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.schedule).toMatchObject({ mode: 'weekly', postsPerWeek: 5 });
    expect(body.slots.map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(body.slots.every((s) => s.time === '12:30' && s.timezone === 'Europe/London')).toBe(
      true,
    );
    await waitFor(() => expect(api.find('GET', UPCOMING).length).toBeGreaterThan(before));
  });
});
