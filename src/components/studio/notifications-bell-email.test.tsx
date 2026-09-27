// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from './library/test-helpers';
import { NotificationsBell, type StudioNotification } from './notifications-bell';

// BACKLOG 13.33: a notification whose email could not be sent yet says so (never "sent").

const item = (over: Partial<StudioNotification>): StudioNotification => ({
  id: 'n1',
  kind: 'publication_failed',
  title: 'Publishing “Launch” to tiktok failed',
  body: 'Open the project to retry.',
  link: '/projects/p1',
  readAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('NotificationsBell email status', () => {
  it('marks email pending setup only on notifications that asked for email', async () => {
    const user = userEvent.setup();
    mockFetch([
      {
        match: '/notifications',
        body: {
          ok: true,
          unreadCount: 2,
          nextCursor: null,
          data: [item({ emailStatus: 'pending_setup' }), item({ id: 'n2', emailStatus: null })],
        },
      },
    ]);
    renderWithSWR(<NotificationsBell />);
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    const items = within(await screen.findByRole('list', { name: 'Notifications' })).getAllByRole(
      'listitem',
    );
    expect(within(items[0]!).getByText(/Email pending setup/)).toBeInTheDocument();
    expect(within(items[1]!).queryByText(/Email pending setup/)).not.toBeInTheDocument();
  });
});
