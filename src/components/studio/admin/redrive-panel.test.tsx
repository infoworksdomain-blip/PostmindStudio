// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { buildBody, RedrivePanel, toLocalInput } from './redrive-panel';
import type { RedriveResponse } from './types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const plan: RedriveResponse = {
  ok: true,
  dryRun: true,
  scope: 'kill_switch',
  counts: { considered: 2, redriven: 1, skipped: 1 },
  items: [
    {
      kind: 'project',
      id: 'proj_1',
      organisationId: 'org_1',
      action: 'resume_assets',
      jobs: ['generate-asset'],
    },
    {
      kind: 'publication',
      id: 'pub_1',
      organisationId: 'org_1',
      action: 'skipped',
      skippedReason: 'kill_switch_still_engaged: platform',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('buildBody', () => {
  const base = {
    scope: 'kill_switch' as const,
    level: '' as const,
    since: '2026-09-27T09:00',
    stuckMinutes: '30',
    organisationId: '',
    limit: '100',
  };

  it('sends since as ISO and omits empty filters for kill_switch', () => {
    const body = buildBody(base, true);
    expect(body).toEqual({
      scope: 'kill_switch',
      since: new Date('2026-09-27T09:00').toISOString(),
      dryRun: true,
      limit: 100,
    });
  });

  it('sends stuckMinutes (and no since or level) for the stuck scope', () => {
    expect(
      buildBody({ ...base, scope: 'stuck', level: 'global', organisationId: ' org_1 ' }, false),
    ).toEqual({
      scope: 'stuck',
      stuckMinutes: 30,
      dryRun: false,
      limit: 100,
      organisationId: 'org_1',
    });
  });

  it('formats datetime-local values', () => {
    expect(toLocalInput(Date.now())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('RedrivePanel', () => {
  it('previews with a dry run, then applies the same filters after confirmation', async () => {
    const user = userEvent.setup();
    const applied: RedriveResponse = { ...plan, dryRun: false };
    const { calls } = mockFetch([
      {
        match: '/admin/redrive',
        method: 'POST',
        body: plan,
      },
    ]);
    renderWithSWR(<RedrivePanel />);
    const form = screen.getByRole('form', { name: 'Re-drive filters' });
    const apply = within(form).getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();

    await user.selectOptions(within(form).getByLabelText('Level'), 'platform');
    await user.type(within(form).getByLabelText('Organisation'), 'org_1');
    await user.click(within(form).getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Preview — nothing has changed yet')).toBeInTheDocument();
    expect(screen.getByText('proj_1')).toBeInTheDocument();
    expect(screen.getByText('kill_switch_still_engaged: platform')).toBeInTheDocument();
    expect(calls[0]?.body).toMatchObject({
      scope: 'kill_switch',
      level: 'platform',
      organisationId: 'org_1',
      dryRun: true,
    });
    expect(calls[0]?.headers['idempotency-key']).toBeTruthy();

    mockFetch([{ match: '/admin/redrive', method: 'POST', body: applied }]);
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Re-drive' }));
    expect(await screen.findByText('Re-drive applied')).toBeInTheDocument();
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('Re-drove 1 item');
    expect(apply).toBeDisabled();
  });

  it('requires a fresh preview after the filters change', async () => {
    const user = userEvent.setup();
    mockFetch([{ match: '/admin/redrive', method: 'POST', body: plan }]);
    renderWithSWR(<RedrivePanel />);
    const form = screen.getByRole('form', { name: 'Re-drive filters' });
    await user.click(within(form).getByRole('button', { name: 'Preview' }));
    await screen.findByText('proj_1');
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Apply' })).toBeEnabled());
    await user.selectOptions(within(form).getByLabelText('Scope'), 'stuck');
    expect(within(form).getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(within(form).getByLabelText('Idle for (minutes)')).toHaveValue(30);
    expect(screen.getByText(/preview again before applying/)).toBeInTheDocument();
  });

  it('reports API errors', async () => {
    const user = userEvent.setup();
    const { toast } = await import('sonner');
    mockFetch([
      {
        match: '/admin/redrive',
        method: 'POST',
        status: 400,
        body: {
          ok: false,
          error: 'validation_error',
          message: 'since must be within the last 30 days',
        },
      },
    ]);
    renderWithSWR(<RedrivePanel />);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('since must be within the last 30 days'),
    );
  });
});
