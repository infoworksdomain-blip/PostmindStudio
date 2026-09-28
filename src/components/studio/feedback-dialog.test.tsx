// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from './library/test-helpers';
import { FeedbackButton, projectIdFromPath } from './feedback-dialog';

// BACKLOG 14.11 — the app shell's Feedback button and dialog (POST /api/studio/feedback).

const nav = vi.hoisted(() => ({ pathname: '/projects/cmproj12345/review' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// jsdom has no ResizeObserver; the Radix Checkbox measures with it.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('projectIdFromPath', () => {
  it('finds the project on project pages only', () => {
    expect(projectIdFromPath('/projects/cmproj12345/review')).toBe('cmproj12345');
    expect(projectIdFromPath('/projects/cmproj12345')).toBe('cmproj12345');
    expect(projectIdFromPath('/projects')).toBeNull();
    expect(projectIdFromPath('/calendar')).toBeNull();
  });
});

describe('FeedbackButton', () => {
  it('sends kind, message, screen and the current project', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/api/studio/feedback', method: 'POST', status: 201, body: { ok: true } },
    ]);
    renderWithSWR(<FeedbackButton />);
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    await user.click(screen.getByRole('radio', { name: 'Something’s broken' }));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), '  The preview froze  ');
    await user.click(send);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({
      kind: 'bug',
      message: 'The preview froze',
      screen: '/projects/cmproj12345/review',
      projectId: 'cmproj12345',
    });
  });

  it('leaves the project out when unticked, and shows errors', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/api/studio/feedback',
        method: 'POST',
        status: 429,
        body: { ok: false, error: 'rate_limited', message: 'At most 10 an hour' },
      },
    ]);
    renderWithSWR(<FeedbackButton />);
    await user.click(screen.getByRole('button', { name: 'Send feedback' }));
    await user.type(screen.getByLabelText('Message'), 'Love the captions');
    await user.click(screen.getByLabelText('This is about the project I’m looking at'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({
      kind: 'idea',
      message: 'Love the captions',
      screen: nav.pathname,
    });
  });
});
