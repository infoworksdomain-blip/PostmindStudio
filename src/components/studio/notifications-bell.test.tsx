// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from './library/test-helpers';
import { NotificationsBell, unreadLabel, type StudioNotification } from './notifications-bell';

const item = (over: Partial<StudioNotification> = {}): StudioNotification => ({
  id: 'n1',
  kind: 'cost_paused',
  title: 'Generation paused: “Launch” reached 90% of its budget',
  body: '£9.00 of £10.00 spent.',
  link: '/projects/p1',
  readAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('NotificationsBell', () => {
  it('shows the unread count and lists notifications with links', async () => {
    const user = userEvent.setup();
    mockFetch([
      {
        match: '/notifications',
        body: {
          ok: true,
          unreadCount: 1,
          nextCursor: null,
          data: [
            item(),
            item({
              id: 'n2',
              kind: 'generation_complete',
              title: '“Launch” is ready for review',
              readAt: new Date().toISOString(),
              link: 'https://evil.example/x',
            }),
          ],
        },
      },
    ]);
    renderWithSWR(<NotificationsBell />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    await user.click(bell);
    const list = await screen.findByRole('list', { name: 'Notifications' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/projects/p1');
    // Only app-relative links are rendered as links.
    expect(within(items[1]!).queryByRole('link')).not.toBeInTheDocument();
    expect(within(items[1]!).queryByRole('button', { name: /Mark/ })).not.toBeInTheDocument();
  });

  it('marks one and all as read', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/notifications/n1/read', method: 'POST', body: { ok: true } },
      { match: '/notifications/read-all', method: 'POST', body: { ok: true, updated: 1 } },
      {
        match: '/notifications',
        body: { ok: true, unreadCount: 1, nextCursor: null, data: [item()] },
      },
    ]);
    renderWithSWR(<NotificationsBell />);
    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    await user.click(await screen.findByRole('button', { name: /Mark “.*” as read/ }));
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/notifications/n1/read')),
      ).toBe(true);
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith('/notifications/read-all')),
      ).toBe(true);
    });
  });

  it('has an empty state and a plain label when nothing is unread', async () => {
    const user = userEvent.setup();
    mockFetch([
      { match: '/notifications', body: { ok: true, unreadCount: 0, nextCursor: null, data: [] } },
    ]);
    renderWithSWR(<NotificationsBell />);
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('No notifications yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('caps the badge at 9+', () => {
    expect(unreadLabel(3)).toBe('3');
    expect(unreadLabel(10)).toBe('9+');
  });
});
