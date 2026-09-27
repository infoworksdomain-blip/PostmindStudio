// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { PublicationsCalendar } from './publications-calendar';
import { MAX_PAGES } from './use-calendar-publications';

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

const SEPT = new Date(2026, 8, 10);

describe('PublicationsCalendar', () => {
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

    const grid = await screen.findByRole('list', { name: 'Days of the month' });
    expect(
      within(grid).getByRole('link', { name: /Video a, YouTube Shorts, Scheduled/ }),
    ).toHaveAttribute('href', '/projects/prj_a');
    expect(
      within(grid).getByRole('link', { name: /Video b, YouTube Shorts, Live/ }),
    ).toBeInTheDocument();
    // the phone agenda lists the same two days
    const agenda = screen.getByRole('list', { name: 'Agenda' });
    expect(within(agenda).getAllByRole('link')).toHaveLength(2);

    const q = api.requests[0]!.url.searchParams;
    expect(q.get('state')).toBe('SCHEDULED,PUBLISHING,PUBLISHED');
    expect(new Date(q.get('from')!).getTime()).toBe(new Date(2026, 7, 31).getTime());
    expect(new Date(q.get('to')!).getTime()).toBe(new Date(2026, 9, 5).getTime());
  });

  it('moves between months', async () => {
    const api = mockFetch(() => ok({ data: [], nextCursor: null }));
    const user = userEvent.setup();
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    await screen.findByText('Nothing scheduled or published this month.');
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: /October 2026/ })).toBeInTheDocument();
    await waitFor(() => expect(api.requests).toHaveLength(2));
    expect(new Date(api.requests[1]!.url.searchParams.get('from')!).getTime()).toBe(
      new Date(2026, 8, 28).getTime(),
    );
  });

  it('follows the cursor but stops after MAX_PAGES pages', async () => {
    let n = 0;
    const api = mockFetch(() => {
      n += 1;
      return ok({ data: [pub(`p${n}`, {})], nextCursor: `c${n}` });
    });
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Showing the first');
    expect(api.requests).toHaveLength(MAX_PAGES);
    expect(api.requests[1]!.url.searchParams.get('cursor')).toBe('c1');
  });

  it('shows the error state', async () => {
    mockFetch(() => fail(500, 'Calendar exploded'));
    renderScreen(<PublicationsCalendar initialDate={SEPT} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Calendar exploded');
  });
});
