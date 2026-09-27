// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from './library/test-helpers';
import { NotificationPreferencesButton, PREFERENCE_ROWS } from './notification-preferences';

// BACKLOG 13.24 — notification preferences dialog (in-app / email per kind; email pending setup).

// jsdom has no ResizeObserver; the Radix Switch measures with it.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

afterEach(() => vi.unstubAllGlobals());

const preferences = Object.fromEntries(
  PREFERENCE_ROWS.map(({ kind }) => [kind, { inApp: true, email: false }]),
);

describe('NotificationPreferencesButton', () => {
  it('lists every kind, says email is pending setup and saves a change', async () => {
    const { calls } = mockFetch([
      {
        match: '/notification-preferences',
        body: { ok: true, preferences, emailDelivery: 'pending_setup' },
      },
      {
        match: '/notification-preferences',
        method: 'PATCH',
        body: {
          ok: true,
          preferences: { ...preferences, milestone: { inApp: false, email: false } },
          emailDelivery: 'pending_setup',
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<NotificationPreferencesButton />);
    await user.click(screen.getByRole('button', { name: 'Notification preferences' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText(/pending setup/i).length).toBeGreaterThan(0);
    const toggle = await within(dialog).findByRole('switch', {
      name: 'Milestones (10k views, 100 comments): in-app',
    });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        milestone: { inApp: false },
      }),
    );
    await waitFor(() => expect(toggle).not.toBeChecked());
  });
});
