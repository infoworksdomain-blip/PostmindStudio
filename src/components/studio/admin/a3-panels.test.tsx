// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { forbidden, mockFetch, renderWithSWR } from '../library/test-helpers';
import { ProvidersPanel, QueuesPanel } from './health-panels';
import { OrganisationPanel } from './organisation-panel';
import { SafetyReviewPanel, type SafetyReviewItem } from './safety-review-panel';

// Phase 13 track A3 Admin Centre tabs: Queues / Providers (13.16), Safety review (13.17) and
// Organisations — review policy (13.18) and cost cap overrides (13.19).

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

describe('QueuesPanel / ProvidersPanel', () => {
  it('shows queue depths and flags slow waits', async () => {
    mockFetch([
      {
        match: '/admin/queues',
        body: {
          ok: true,
          queues: [
            {
              name: 'studio-assets',
              waiting: 14,
              active: 5,
              failed: 2,
              delayed: 0,
              oldestWaitingSec: 41,
            },
            {
              name: 'studio-publish',
              waiting: 0,
              active: 0,
              failed: 0,
              delayed: 3,
              oldestWaitingSec: 3_700,
            },
          ],
        },
      },
    ]);
    renderWithSWR(<QueuesPanel />);
    const table = await screen.findByRole('table', { name: 'Queue health' });
    const assets = within(table).getByRole('row', { name: /studio-assets/ });
    expect(within(assets).getByText('41s')).toBeInTheDocument();
    expect(within(table).getByText('1h 1m')).toBeInTheDocument();
  });

  it('shows breaker state, error rate and spend per provider', async () => {
    mockFetch([
      {
        match: '/admin/providers',
        body: {
          ok: true,
          providers: [
            {
              id: 'shotstack',
              configured: true,
              breaker: 'open',
              errorRate1h: 0.58,
              jobs1h: { succeeded: 5, failed: 7, running: 0 },
              spendTodayPence: 310,
              healthy: false,
            },
            {
              id: 'pika',
              configured: false,
              breaker: 'closed',
              errorRate1h: null,
              jobs1h: { succeeded: 0, failed: 0, running: 0 },
              spendTodayPence: 0,
              healthy: false,
            },
          ],
        },
      },
    ]);
    renderWithSWR(<ProvidersPanel />);
    const row = await screen.findByRole('row', { name: /shotstack/ });
    expect(within(row).getByText('Open')).toBeInTheDocument();
    expect(within(row).getByText('58%')).toBeInTheDocument();
    expect(within(row).getByText('£3.10')).toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
  });

  it('20.11: shows an account hold with its reason and resume time (UTC)', async () => {
    mockFetch([
      {
        match: '/admin/providers',
        body: {
          ok: true,
          providers: [
            {
              id: 'anthropic',
              configured: true,
              breaker: 'open',
              errorRate1h: 1,
              jobs1h: { succeeded: 0, failed: 3, running: 0 },
              spendTodayPence: 0,
              accountHold: {
                errorClass: 'account_limit',
                reason: '400 You have reached your specified API usage limits.',
                until: '2026-10-01T00:00:00.000Z',
                since: '2026-09-30T18:00:00.000Z',
              },
              healthy: false,
            },
          ],
        },
      },
    ]);
    renderWithSWR(<ProvidersPanel />);
    const row = await screen.findByRole('row', { name: /anthropic/ });
    expect(
      within(row).getByText(/Held: usage limit reached until .*1 Oct 2026.* UTC/),
    ).toBeInTheDocument();
    expect(within(row).getByText(/specified API usage limits/)).toBeInTheDocument();
  });

  it('shows the error state for a non-staff account', async () => {
    mockFetch([{ match: '/admin/queues', status: 403, body: forbidden }]);
    renderWithSWR(<QueuesPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
  });
});

const review = (over: Partial<SafetyReviewItem> = {}): SafetyReviewItem => ({
  id: 'sr-1',
  organisationId: 'org-1',
  projectId: 'prj-1',
  projectName: 'Mushroom coffee',
  projectState: 'PLANNING',
  kind: 'script',
  state: 'PENDING',
  reason: 'Script safety REVIEW (medical_misinformation): cures brain fog',
  previewUrl: null,
  scripts: [{ platform: 'tiktok', excerpt: 'Cures brain fog in a week.' }],
  decisionNote: null,
  decidedAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('SafetyReviewPanel', () => {
  it('lists pending reviews and blocks one with a note', async () => {
    const { calls } = mockFetch([
      {
        match: '/admin/safety-reviews?state=PENDING',
        body: { ok: true, data: [review()], pendingCount: 1, hasMore: false },
      },
      {
        match: '/admin/safety-reviews/sr-1/decision',
        method: 'POST',
        body: {
          ok: true,
          review: { id: 'sr-1', state: 'BLOCKED' },
          project: { id: 'prj-1', state: 'FAILED' },
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<SafetyReviewPanel />);
    expect(await screen.findByText('Mushroom coffee')).toBeInTheDocument();
    expect(screen.getByText(/Cures brain fog in a week/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Block' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Health claim is misleading');
    await user.click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        decision: 'BLOCK',
        note: 'Health claim is misleading',
      }),
    );
  });

  it('shows a video preview for content reviews and an empty state', async () => {
    mockFetch([
      {
        match: '/admin/safety-reviews?state=PENDING',
        body: {
          ok: true,
          data: [review({ kind: 'content', previewUrl: 'https://cdn.test/r.mp4', scripts: [] })],
          pendingCount: 1,
          hasMore: false,
        },
      },
      {
        match: '/admin/safety-reviews?state=ALLOWED',
        body: { ok: true, data: [], pendingCount: 1, hasMore: false },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<SafetyReviewPanel />);
    expect(await screen.findByLabelText('Preview of Mushroom coffee')).toHaveAttribute(
      'src',
      'https://cdn.test/r.mp4',
    );
    await user.selectOptions(screen.getByLabelText('Show reviews'), 'ALLOWED');
    expect(await screen.findByText('No reviews yet')).toBeInTheDocument();
  });
});

describe('OrganisationPanel', () => {
  it('loads one organisation and saves its policy and a cost cap override', async () => {
    const { calls } = mockFetch([
      {
        match: '/admin/organisations/org-york/policy',
        body: {
          ok: true,
          organisationId: 'org-york',
          policy: {
            defaultReviewPolicy: 'REQUIRE_APPROVAL',
            autoApproveTrustThreshold: 10,
            autoApproveAllowed: true,
          },
          source: {
            defaultReviewPolicy: 'default',
            autoApproveTrustThreshold: 'default',
            autoApproveAllowed: 'default',
          },
          updatedAt: null,
        },
      },
      { match: '/admin/organisations/org-york/policy', method: 'PUT', body: { ok: true } },
      {
        match: '/admin/organisations/org-york/cost-caps',
        body: {
          ok: true,
          organisationId: 'org-york',
          caps: {
            daily: {
              pence: null,
              source: 'plan_tier',
              byTier: { STANDARD: { pence: 3_000, source: 'default' } },
            },
            monthly: {
              pence: null,
              source: 'plan_tier',
              byTier: { STANDARD: { pence: 15_000, source: 'default' } },
            },
          },
          override: null,
        },
      },
      { match: '/admin/organisations/org-york/cost-caps', method: 'PUT', body: { ok: true } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<OrganisationPanel />);
    await user.type(screen.getByLabelText('Organisation id'), 'org-york');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const policy = await screen.findByRole('form', { name: 'Review policy' });
    await user.click(within(policy).getByLabelText('Allow automatic approval'));
    await user.click(within(policy).getByRole('button', { name: /Save policy/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url.includes('/policy'))?.body).toEqual({
        defaultReviewPolicy: 'REQUIRE_APPROVAL',
        autoApproveAllowed: false,
        autoApproveTrustThreshold: 10,
      }),
    );

    const caps = await screen.findByRole('form', { name: 'Cost cap overrides' });
    expect(within(caps).getByText(/Standard £30\.00/)).toBeInTheDocument();
    const save = within(caps).getByRole('button', { name: /Save cost caps/ });
    expect(save).toBeDisabled(); // a reason is required
    await user.type(within(caps).getByLabelText('Daily cap override (£)'), '200');
    await user.type(within(caps).getByLabelText(/Reason/), 'Pilot, agreed with Commercial');
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url.includes('/cost-caps'))?.body).toEqual({
        dailyPence: 20_000,
        monthlyPence: null,
        reason: 'Pilot, agreed with Commercial',
      }),
    );
  });
});

describe('OrganisationPanel i18n (BACKLOG 16.1)', () => {
  it('renders in Arabic, right to left', () => {
    renderWithSWR(withLocale('ar', <OrganisationPanel />));
    expect(screen.getByLabelText('معرّف المؤسسة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'فتح' })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
  });

  it('renders in Simplified Chinese', () => {
    renderWithSWR(withLocale('zh-Hans', <OrganisationPanel />));
    expect(screen.getByLabelText('组织 ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开' })).toBeInTheDocument();
  });
});
