// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { BetaPanel, type BetaDashboardResponse } from './beta-panel';
import { SafetyAuditPanel, type AuditItem, type AuditResponse } from './safety-audit-panel';

// BACKLOG 14.11 — Admin → Beta (cohort dashboard, enrolment, feedback) and Admin → Safety audit
// (monthly Trust & Safety sample, pass / miss).

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

const dashboard: BetaDashboardResponse = {
  days: 30,
  cohorts: ['beta-1'],
  totals: {
    organisations: 1,
    videosGenerated: 12,
    videosFailed: 4,
    videosPublished: 9,
    costPence: 4_210,
    feedbackCount: 3,
    failureRate: 0.25,
  },
  organisations: [
    {
      organisationId: 'org_leeds',
      cohort: 'beta-1',
      plusUntil: '2026-10-28T00:00:00.000Z',
      plusActive: true,
      enrolledAt: '2026-09-28T00:00:00.000Z',
      videosGenerated: 12,
      videosFailed: 4,
      videosPublished: 9,
      failureRate: 0.25,
      costPence: 4_210,
      feedbackCount: 3,
    },
  ],
  recentFeedback: [],
};

const feedback = {
  ok: true,
  data: [
    {
      id: 'fb1',
      organisationId: 'org_leeds',
      userId: 'u1',
      kind: 'bug',
      message: 'Preview froze on Safari',
      projectId: null,
      screen: '/projects',
      createdAt: '2026-09-28T10:00:00.000Z',
    },
  ],
  hasMore: false,
};

describe('BetaPanel', () => {
  it('shows cohort totals, per-organisation usage and feedback', async () => {
    mockFetch([
      { match: '/admin/beta', body: { ok: true, ...dashboard } },
      { match: '/admin/feedback', body: feedback },
    ]);
    renderWithSWR(<BetaPanel />);
    const row = await screen.findByRole('row', { name: /org_leeds/ });
    expect(within(row).getByText('25%')).toBeInTheDocument();
    expect(within(row).getByText('£42.10')).toBeInTheDocument();
    expect(await screen.findByText('Preview froze on Safari')).toBeInTheDocument();
  });

  it('renders in Arabic (right to left) and Simplified Chinese', async () => {
    mockFetch([
      { match: '/admin/beta', body: { ok: true, ...dashboard } },
      { match: '/admin/feedback', body: feedback },
    ]);
    const { unmount } = renderWithSWR(withLocale('ar', <BetaPanel />));
    expect(
      await screen.findByRole('heading', { name: 'مجموعة النسخة التجريبية' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: /org_leeds/ })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    unmount();

    renderWithSWR(withLocale('zh-Hans', <BetaPanel />));
    expect(await screen.findByRole('heading', { name: 'Beta 用户群' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入' })).toBeInTheDocument();
  });

  it('enrols an organisation with Plus for 30 days, or without Plus', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/beta', body: { ok: true, ...dashboard, organisations: [], cohorts: [] } },
      { match: '/admin/feedback', body: { ok: true, data: [], hasMore: false } },
      { match: '/admin/organisations/org_new/beta', method: 'PUT', body: { ok: true } },
    ]);
    renderWithSWR(<BetaPanel />);
    expect(await screen.findByText('No beta organisations yet')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Organisation id'), 'org_new');
    await user.click(screen.getByRole('button', { name: 'Enrol' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ cohort: 'beta-1' });

    await user.type(screen.getByLabelText('Organisation id'), 'org_new');
    await user.click(screen.getByLabelText('Plus for 30 days'));
    await user.click(screen.getByRole('button', { name: 'Enrol' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PUT')[1]?.body).toEqual({
      cohort: 'beta-1',
      plusUntil: null,
    });
  });
});

const item = (over: Partial<AuditItem> = {}): AuditItem => ({
  id: 'a1',
  period: '2026-08',
  organisationId: 'org_leeds',
  publicationId: 'pub1',
  projectId: 'p1',
  platform: 'tiktok',
  platformUrl: 'https://www.tiktok.com/@leeds/video/1',
  publishedAt: '2026-08-10T00:00:00.000Z',
  result: 'pending',
  note: null,
  reviewedAt: null,
  previewUrl: 'https://cdn.test/r.mp4',
  ...over,
});

const audit = (over: Partial<AuditResponse> = {}): AuditResponse & { ok: true } => ({
  ok: true,
  summary: { period: '2026-08', sampled: 50, pending: 48, passed: 1, missed: 1, missRate: 0.5 },
  periods: ['2026-08', '2026-07'],
  data: [item()],
  hasMore: false,
  ...over,
});

describe('SafetyAuditPanel', () => {
  it('shows the summary with the Hive scan miss rate and records a pass', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/safety-audit?', body: audit() },
      { match: '/admin/safety-audit/a1/result', method: 'POST', body: { ok: true } },
    ]);
    renderWithSWR(<SafetyAuditPanel />);
    expect(await screen.findByText('50.0%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the post/ })).toHaveAttribute(
      'href',
      'https://www.tiktok.com/@leeds/video/1',
    );
    await user.click(screen.getByRole('button', { name: 'Pass' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Recorded as pass'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ result: 'pass' });
  });

  it('records a miss with a note', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { match: '/admin/safety-audit?', body: audit() },
      { match: '/admin/safety-audit/a1/result', method: 'POST', body: { ok: true } },
    ]);
    renderWithSWR(<SafetyAuditPanel />);
    await user.click(await screen.findByRole('button', { name: 'Miss' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Shows a weapon');
    await user.click(within(dialog).getByRole('button', { name: 'Record miss' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        result: 'miss',
        note: 'Shows a weapon',
      }),
    );
  });

  it('offers to draw the sample when the month has none', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        match: '/admin/safety-audit?',
        body: audit({
          data: [],
          summary: {
            period: '2026-09',
            sampled: 0,
            pending: 0,
            passed: 0,
            missed: 0,
            missRate: null,
          },
          periods: [],
        }),
      },
      {
        match: '/admin/safety-audit/sample',
        method: 'POST',
        body: { ok: true, sample: { added: 12, total: 12, population: 12 } },
      },
    ]);
    renderWithSWR(<SafetyAuditPanel />);
    expect(await screen.findByText('No sample for this month')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Draw sample' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ period: '2026-09' });
  });
});
