// @vitest-environment jsdom
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTranslations } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { DeadLetterPanel, outcomeText, type FailedPage } from './dead-letter-panel';
import { ForceApprovalsPanel } from './force-approvals-panel';
import { GLOBAL_CONFIRM_PHRASE, KillSwitchPanel } from './kill-switch-panel';
import { minutesLeft } from './pending-global-kill';
import type { KillSwitchState } from './types';

// BACKLOG 15.D4–15.D6 Admin Centre panels: dead letters, force-approvals, pending global kill.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const page: FailedPage = {
  ok: true,
  queue: 'studio-assets',
  total: 2,
  nextCursor: null,
  jobs: [
    {
      id: 'gen-1',
      name: 'generate-asset',
      data: { projectId: 'prj_1', shotId: 'shot_1', sourceUrl: 'https://x/?sig=redacted' },
      failedReason: 'runway/invalid_request: prompt refused',
      stacktrace: [],
      attemptsMade: 1,
      organisationId: 'org_1',
      projectId: 'prj_1',
      addedAt: '2026-09-28T09:00:00.000Z',
      processedAt: '2026-09-28T09:00:01.000Z',
      failedAt: '2026-09-28T09:00:02.000Z',
      providerOverride: true,
    },
    {
      id: 'scan-1',
      name: 'scan-website',
      data: { scanId: 's' },
      failedReason: 'site unreachable',
      stacktrace: [],
      attemptsMade: 6,
      organisationId: 'org_2',
      projectId: null,
      addedAt: '2026-09-28T08:00:00.000Z',
      processedAt: null,
      failedAt: '2026-09-28T08:05:00.000Z',
      providerOverride: false,
    },
  ],
};

describe('DeadLetterPanel', () => {
  it('lists failed jobs and requeues a generate-asset job with a provider preference', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/requeue',
        method: 'POST',
        body: {
          ok: true,
          job: { id: 'gen-1', name: 'generate-asset' },
          outcome: { action: 'resumed_project', projectId: 'prj_1', runId: 'r2', jobs: 2 },
        },
      },
      { match: '/admin/queues/studio-assets/failed', body: page },
    ]);
    renderWithSWR(<DeadLetterPanel />);
    expect(await screen.findByText('runway/invalid_request: prompt refused')).toBeInTheDocument();
    expect(screen.getByText(/2 failed in studio-assets/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Requeue gen-1' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/Prefer provider/), 'luma');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Runway refusing');
    await user.click(within(dialog).getByRole('button', { name: 'Requeue' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: expect.stringContaining('/admin/queues/studio-assets/failed/gen-1/requeue'),
        body: { providerId: 'luma', reason: 'Runway refusing' },
      }),
    );
  });

  it('offers no provider choice for other job types and retries with a reason', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/retry',
        method: 'POST',
        body: { ok: true, job: { id: 'scan-1' }, advisory: null },
      },
      { match: '/admin/queues/studio-assets/failed', body: page },
    ]);
    renderWithSWR(<DeadLetterPanel />);
    await user.click(await screen.findByRole('button', { name: 'Requeue scan-1' }));
    const requeue = await screen.findByRole('dialog');
    expect(within(requeue).queryByLabelText(/Prefer provider/)).not.toBeInTheDocument();
    await user.click(within(requeue).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Retry scan-1' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'site is back');
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: expect.stringContaining('/failed/scan-1/retry'),
        body: { reason: 'site is back' },
      }),
    );
  });

  it('drains only after the queue name is typed', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/drain', method: 'POST', body: { ok: true, queue: 'studio-assets', removed: 2 } },
      { match: '/admin/queues/studio-assets/failed', body: page },
    ]);
    renderWithSWR(<DeadLetterPanel />);
    await user.click(await screen.findByRole('button', { name: 'Drain queue' }));
    const dialog = await screen.findByRole('dialog');
    const drain = within(dialog).getByRole('button', { name: 'Drain' });
    await user.type(within(dialog).getByLabelText(/Reason/), 'old outage');
    expect(drain).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), 'studio-assets');
    await user.click(drain);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        confirm: 'studio-assets',
        reason: 'old outage',
      }),
    );
  });

  it('shows the empty state and switches queue', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/failed',
        body: { ok: true, queue: 'studio-assets', total: 0, jobs: [], nextCursor: null },
      },
    ]);
    renderWithSWR(<DeadLetterPanel />);
    expect(await screen.findByText('No failed jobs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drain queue' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Queue'), 'studio-publish');
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/admin/queues/studio-publish/failed'))).toBe(true),
    );
  });

  it('describes requeue outcomes', () => {
    const { result } = renderHook(() => useTranslations('admin.deadLetters'));
    const t = result.current;
    expect(outcomeText({ action: 'requeued' }, t)).toBe('Requeued');
    expect(
      outcomeText({ action: 'resumed_project', projectId: 'p', runId: 'r', jobs: 1 }, t),
    ).toMatch(/project p resumed its asset stage \(1 job\)/);
  });
});

describe('ForceApprovalsPanel', () => {
  it('lists overrides with note, user and failed checks, and changes the window', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/admin/force-approvals',
        body: {
          ok: true,
          days: 30,
          since: '2026-08-29T00:00:00.000Z',
          truncated: false,
          items: [
            {
              renderId: 'r1',
              targetPlatform: 'tiktok',
              aspectRatio: '9:16',
              renderCreatedAt: '2026-09-27T10:00:00.000Z',
              approvedAt: '2026-09-27T10:05:00.000Z',
              approvedAtRecorded: true,
              approvedByUserId: 'user_7',
              note: 'Quiet on purpose',
              failedChecks: [{ code: 'audio_present', severity: 'error', detail: '-30 LUFS' }],
              project: { id: 'p1', name: 'ASMR bakery', state: 'APPROVED', businessId: 'b' },
              organisationId: 'org_1',
            },
          ],
        },
      },
    ]);
    renderWithSWR(<ForceApprovalsPanel />);
    expect(await screen.findByText('ASMR bakery')).toBeInTheDocument();
    expect(screen.getByText(/Quiet on purpose/)).toBeInTheDocument();
    expect(screen.getByText('user_7')).toBeInTheDocument();
    expect(screen.getByText(/audio_present \(-30 LUFS\)/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Window'), '90');
    await waitFor(() => expect(calls.some((c) => c.url.includes('days=90'))).toBe(true));
  });

  it('shows the empty state', async () => {
    mockFetch([
      {
        match: '/admin/force-approvals',
        body: { ok: true, days: 30, since: '', truncated: false, items: [] },
      },
    ]);
    renderWithSWR(<ForceApprovalsPanel />);
    expect(await screen.findByText('No force-approvals')).toBeInTheDocument();
  });
});

describe('pending global kill (15.D6)', () => {
  const base: KillSwitchState = {
    ok: true,
    global: { enabled: false, since: null },
    frozenWorkspaces: [],
    killedProjects: [],
    disabledProviders: [],
    disabledPlatforms: [],
    propagationSec: 30,
    singleApprover: false,
  };
  const pending = (requestedByYou: boolean) => ({
    requestId: 'req-1',
    requestedBy: 'staff-alice',
    reason: 'Runway cost runaway',
    requestedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    requestedByYou,
  });

  it('lets a second staff member confirm with the typed phrase', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/global/confirm', method: 'POST', body: { ok: true, flag: {} } },
      { match: '/admin/kill-switch', body: { ...base, pendingGlobal: pending(false) } },
    ]);
    renderWithSWR(<KillSwitchPanel />);
    expect(
      await screen.findByRole('heading', { name: 'Global kill waiting for a second approver' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Runway cost runaway')).toBeInTheDocument();
    // A second request cannot be started while one is pending.
    expect(screen.getByRole('button', { name: 'Engage global kill switch' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Confirm and halt Studio' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Agreed, spend spiking');
    await user.type(within(dialog).getByLabelText(/to confirm/), GLOBAL_CONFIRM_PHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and halt' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        requestId: 'req-1',
        reason: 'Agreed, spend spiking',
      }),
    );
  });

  it('stops the requester confirming their own request; anyone can withdraw it', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/global/pending', method: 'DELETE', body: { ok: true, withdrawn: {} } },
      { match: '/admin/kill-switch', body: { ...base, pendingGlobal: pending(true) } },
    ]);
    renderWithSWR(<KillSwitchPanel />);
    expect(await screen.findByRole('button', { name: 'Confirm and halt Studio' })).toBeDisabled();
    expect(screen.getByText(/Another PostMind staff member must confirm/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('explains the two-person rule, or the break-glass mode', async () => {
    mockFetch([{ match: '/admin/kill-switch', body: base }]);
    const { unmount } = renderWithSWR(<KillSwitchPanel />);
    expect(await screen.findByText(/Engaging needs two people/)).toBeInTheDocument();
    unmount();
    mockFetch([{ match: '/admin/kill-switch', body: { ...base, singleApprover: true } }]);
    renderWithSWR(<KillSwitchPanel />);
    expect(await screen.findByText(/Break-glass is on/)).toBeInTheDocument();
  });

  it('counts down the minutes left', () => {
    expect(minutesLeft('2026-09-28T10:10:00Z', Date.parse('2026-09-28T10:00:30Z'))).toBe(10);
    expect(minutesLeft('2026-09-28T10:00:00Z', Date.parse('2026-09-28T10:05:00Z'))).toBe(0);
  });
});
