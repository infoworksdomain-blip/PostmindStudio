// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Publication } from '@/lib/client/types';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { dayKey, fromLocalInput, moveToDay, toLocalInput } from './month';
import { PublicationsCalendar } from './publications-calendar';
import { DRAG_TYPE } from './reschedule';

// BACKLOG 13.9 — calendar drag-to-reschedule and the keyboard "Move to" alternative.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// A month well in the future, so every move is inside the 1 minute – 180 days window.
const future = new Date();
future.setDate(future.getDate() + 40);
const MONTH = new Date(future.getFullYear(), future.getMonth(), 10);
const AT = new Date(future.getFullYear(), future.getMonth(), 14, 10, 30);

function pub(id: string, overrides: Partial<Publication> = {}): Publication {
  return {
    id,
    projectId: `prj_${id}`,
    renderId: 'ren',
    platform: 'tiktok',
    platformAccountId: 'acc',
    state: 'SCHEDULED',
    scheduledFor: AT.toISOString(),
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

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('month helpers for rescheduling', () => {
  it('moveToDay keeps the local time of day', () => {
    const to = moveToDay(AT.toISOString(), new Date(2027, 0, 3));
    expect([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours(), to.getMinutes()]).toEqual(
      [2027, 0, 3, 10, 30],
    );
  });

  it('round-trips datetime-local values', () => {
    const value = toLocalInput(AT.toISOString());
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T10:30$/);
    expect(fromLocalInput(value)?.getTime()).toBe(AT.getTime());
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
  });
});

describe('PublicationsCalendar rescheduling', () => {
  it('only scheduled posts get a move button', async () => {
    mockFetch((req) =>
      req.method === 'GET'
        ? ok({
            data: [
              pub('a'),
              pub('b', { state: 'PUBLISHED', scheduledFor: null, publishedAt: AT.toISOString() }),
            ],
            nextCursor: null,
          })
        : undefined,
    );
    renderScreen(<PublicationsCalendar initialDate={MONTH} />);
    const grid = await screen.findByRole('list', { name: 'Days of the month' });
    expect(
      within(grid).getByRole('button', { name: 'Move Video a to another time' }),
    ).toBeVisible();
    expect(within(grid).queryByRole('button', { name: /Move Video b/ })).not.toBeInTheDocument();
  });

  it('"Move to" PATCHes the chosen time and refreshes', async () => {
    const user = userEvent.setup();
    const api = mockFetch((req) =>
      req.method === 'PATCH'
        ? ok({ publication: pub('a') })
        : ok({ data: [pub('a')], nextCursor: null }),
    );
    renderScreen(<PublicationsCalendar initialDate={MONTH} />);
    const grid = await screen.findByRole('list', { name: 'Days of the month' });
    await user.click(within(grid).getByRole('button', { name: 'Move Video a to another time' }));
    const dialog = await screen.findByRole('dialog', { name: /Move “Video a”/ });
    const input = within(dialog).getByLabelText('New time');
    expect(input).toHaveValue(toLocalInput(AT.toISOString()));
    const target = new Date(AT.getFullYear(), AT.getMonth(), 20, 8, 15);
    fireEvent.change(input, { target: { value: toLocalInput(target.toISOString()) } });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.find('PATCH', '/publications/a')).toHaveLength(1));
    expect(api.find('PATCH', '/publications/a')[0]?.body).toEqual({
      scheduledFor: target.toISOString(),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(api.find('GET', '/publications').length).toBeGreaterThan(1));
  });

  it('dragging a post onto another day moves it there at the same time', async () => {
    const api = mockFetch((req) =>
      req.method === 'PATCH'
        ? ok({ publication: pub('a') })
        : ok({ data: [pub('a')], nextCursor: null }),
    );
    const { container } = renderScreen(<PublicationsCalendar initialDate={MONTH} />);
    const grid = await screen.findByRole('list', { name: 'Days of the month' });
    const handle = within(grid)
      .getByRole('button', { name: 'Move Video a to another time' })
      .closest('[draggable="true"]') as HTMLElement;
    const transfer = dataTransfer();
    fireEvent.dragStart(handle, { dataTransfer: transfer });
    expect(transfer.getData(DRAG_TYPE)).toBe('a');
    const day = new Date(AT.getFullYear(), AT.getMonth(), 16);
    const cell = container.querySelector(`[data-day="${dayKey(day)}"]`) as HTMLElement;
    fireEvent.dragOver(cell, { dataTransfer: transfer });
    fireEvent.drop(cell, { dataTransfer: transfer });
    await waitFor(() => expect(api.find('PATCH', '/publications/a')).toHaveLength(1));
    expect(api.find('PATCH', '/publications/a')[0]?.body).toEqual({
      scheduledFor: new Date(AT.getFullYear(), AT.getMonth(), 16, 10, 30).toISOString(),
    });
  });

  it('shows the server refusal (409) and never PATCHes a past time', async () => {
    const user = userEvent.setup();
    const api = mockFetch((req) =>
      req.method === 'PATCH'
        ? fail(409, 'Only scheduled publications can be moved (this one is PUBLISHING)')
        : ok({ data: [pub('a')], nextCursor: null }),
    );
    renderScreen(<PublicationsCalendar initialDate={MONTH} />);
    const grid = await screen.findByRole('list', { name: 'Days of the month' });
    await user.click(within(grid).getByRole('button', { name: 'Move Video a to another time' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('New time');
    fireEvent.change(input, { target: { value: '2020-01-01T09:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(toast.error).toHaveBeenCalledWith('Pick a time at least a minute from now.');
    expect(api.find('PATCH', '/publications/a')).toHaveLength(0);

    fireEvent.change(input, {
      target: { value: toLocalInput(new Date(AT.getTime() + 86_400_000).toISOString()) },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Only scheduled publications can be moved (this one is PUBLISHING)',
      ),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
