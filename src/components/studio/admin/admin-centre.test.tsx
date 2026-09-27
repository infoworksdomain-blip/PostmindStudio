// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forbidden, mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { AdminCentre } from './admin-centre';
import { GLOBAL_CONFIRM_PHRASE } from './kill-switch-panel';
import type { KillSwitchState } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const running: KillSwitchState = {
  ok: true,
  global: { enabled: false, since: null },
  frozenWorkspaces: [{ id: 'org_frozen', since: '2026-09-26T10:00:00.000Z' }],
  killedProjects: [],
  disabledProviders: [{ id: 'runway', since: '2026-09-25T10:00:00.000Z' }],
  propagationSec: 30,
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    {
      match: '/admin/kill-switch',
      method: 'PUT',
      body: { ok: true, flag: { key: 'k', value: 'true' } },
    },
    { match: '/admin/kill-switch', body: running },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AdminCentre access', () => {
  it('shows the staff-only state on 403', async () => {
    mockFetch([{ match: '/admin/kill-switch', status: 403, body: forbidden }]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByText('PostMind staff only')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('shows an error (not the staff state) for other failures', async () => {
    mockFetch([
      {
        match: '/admin/kill-switch',
        status: 500,
        body: { ok: false, error: 'internal', message: 'Flags unavailable' },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Flags unavailable');
    expect(screen.queryByText('PostMind staff only')).not.toBeInTheDocument();
  });
  it('switches between the admin tabs', async () => {
    const user = userEvent.setup();
    mockFetch([
      ...routes(),
      { match: '/library/categories', body: { ok: true, data: [] } },
      { match: '/library/videos', body: { ok: true, data: [], nextCursor: null } },
      { match: '/admin/cost', body: { ok: true, days: 30, data: [] } },
    ]);
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('tab', { name: 'Library' }));
    expect(await screen.findByText('Add to the corpus')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Cost report' }));
    expect(await screen.findByText('No provider usage in this window.')).toBeInTheDocument();
  });
});

describe('Kill switch tab', () => {
  it('lists active scoped switches', async () => {
    mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('heading', { name: 'Studio is running' })).toBeInTheDocument();
    expect(screen.getByText('org_frozen', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(screen.getByText('runway', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(screen.getByText('No projects killed.')).toBeInTheDocument();
  });

  it('requires a reason and the typed phrase before halting Studio', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Engage global kill switch' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Halt Studio' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Reason/), 'Provider incident');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'halt all studio');
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/to confirm/));
    await user.type(within(dialog).getByLabelText(/to confirm/), GLOBAL_CONFIRM_PHRASE);
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ level: 'global', enabled: true, reason: 'Provider incident' });
    expect(put?.headers['idempotency-key']).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('releases the global switch without a typed phrase', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/kill-switch', method: 'PUT', body: { ok: true, flag: {} } },
      {
        match: '/admin/kill-switch',
        body: { ...running, global: { enabled: true, since: '2026-09-27T08:00:00.000Z' } },
      },
    ]);
    renderWithSWR(<AdminCentre />);
    expect(await screen.findByRole('heading', { name: 'Studio is halted' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Release global kill switch' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), 'All clear');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'global',
        enabled: false,
        reason: 'All clear',
      }),
    );
  });

  it('releases a scoped switch', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Release runway' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Recovered');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'provider',
        target: 'runway',
        enabled: false,
        reason: 'Recovered',
      }),
    );
  });

  it('engages a provider switch from the scoped form', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderWithSWR(<AdminCentre />);
    const form = await screen.findByRole('form', { name: 'Engage a scoped kill switch' });
    const engage = within(form).getByRole('button', { name: 'Engage' });
    expect(engage).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Level'), 'provider');
    await user.selectOptions(within(form).getByLabelText('Provider'), 'luma');
    await user.type(within(form).getByLabelText('Reason'), 'Latency spike');
    await user.click(engage);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        level: 'provider',
        target: 'luma',
        enabled: true,
        reason: 'Latency spike',
      }),
    );
  });

  it('keeps the dialog open and reports when the PUT fails', async () => {
    const user = userEvent.setup();
    const { toast } = await import('sonner');
    mockFetch([
      {
        match: '/admin/kill-switch',
        method: 'PUT',
        status: 400,
        body: { ok: false, error: 'validation_error', message: 'Unknown providerId' },
      },
      { match: '/admin/kill-switch', body: running },
    ]);
    renderWithSWR(<AdminCentre />);
    await user.click(await screen.findByRole('button', { name: 'Release org_frozen' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Try it');
    await user.click(within(dialog).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unknown providerId'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
