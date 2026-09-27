// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../library/test-helpers';
import { ResubmitFailures } from './resubmit-failures';

// BACKLOG 13.15 — the admin "Resubmit failures" button.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
afterEach(() => {
  vi.unstubAllGlobals();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ResubmitFailures', () => {
  it('is disabled with no failures', () => {
    render(<ResubmitFailures failed={0} onDone={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Resubmit failures' })).toBeDisabled();
  });

  it('POSTs failedOnly and reports queued / skipped', async () => {
    const onDone = vi.fn();
    const { calls } = mockFetch([
      {
        match: '/admin/library/ingest/resubmit',
        method: 'POST',
        body: {
          ok: true,
          queued: 3,
          skipped: 1,
          runs: [
            { runId: 'r', action: 'skipped', reason: 'no stored item (submitted before 13.15)' },
          ],
        },
      },
    ]);
    render(<ResubmitFailures failed={4} onDone={onDone} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resubmit failures' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({ failedOnly: true });
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('Resubmitted 3 failed sources'),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('use the ingest tool'));
  });

  it('shows the error when the API refuses', async () => {
    mockFetch([
      {
        match: '/admin/library/ingest/resubmit',
        method: 'POST',
        status: 403,
        body: { ok: false, error: 'forbidden', message: 'Platform staff only' },
      },
    ]);
    render(<ResubmitFailures failed={1} onDone={() => undefined} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resubmit failures' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
