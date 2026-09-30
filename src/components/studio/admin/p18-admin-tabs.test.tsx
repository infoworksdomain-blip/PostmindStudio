// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { LegalReadinessWarning } from './legal-readiness-warning';
import { OrganisationsTab } from './organisations/organisations-tab';
import { SubscriptionsTab } from './subscriptions/subscriptions-tab';
import { UsersTab } from './users/users-tab';

// Phase 18 Track E — admin Organisations, Users and Subscriptions tabs, impersonation button
// only when switched on, and the legal-readiness warning.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const orgRow = {
  id: 'org_1',
  name: 'Crumb & Co',
  slug: 'crumb',
  country: 'GB',
  createdAt: '2026-09-01T00:00:00Z',
  deletedAt: null,
  members: 3,
  tier: 'STANDARD',
  access: 'full',
  subscriptionStatus: 'past_due',
  costThisMonthPence: 1234,
};

const orgDetail = {
  ok: true,
  organisation: { ...orgRow, defaultLocale: 'en-GB' },
  members: [
    {
      id: 'm1',
      userId: 'u1',
      name: 'Ada Baker',
      email: 'ada@example.test',
      role: 'owner',
      twoFactorEnabled: true,
      joinedAt: '2026-09-01T00:00:00Z',
    },
  ],
  pendingInvitations: 1,
  businesses: 2,
  entitlement: {
    tier: 'STANDARD',
    access: 'full',
    source: 'stripe',
    graceUntil: '2026-10-05T00:00:00Z',
    trialStartedAt: null,
    everPaidAt: '2026-09-01T00:00:00Z',
    reason: null,
    updatedAt: '2026-09-28T00:00:00Z',
  },
  subscriptions: [
    {
      id: 'sub_1',
      organisationId: 'org_1',
      status: 'past_due',
      lookupKey: 'studio_standard_monthly',
      interval: 'month',
      currentPeriodEnd: '2026-10-01T00:00:00Z',
      cancelAtPeriodEnd: false,
      trialEnd: null,
      updatedAt: '2026-09-28T00:00:00Z',
    },
  ],
  costThisMonthPence: 1234,
};

const user1 = {
  id: 'u1',
  name: 'Ada Baker',
  email: 'ada@example.test',
  emailVerified: true,
  twoFactorEnabled: true,
  role: 'user',
  banned: false,
  banReason: null,
  createdAt: '2026-09-01T00:00:00Z',
  deletedAt: null,
  sessions: 2,
  organisations: 1,
};

describe('OrganisationsTab', () => {
  it('searches, then opens one organisation with plan, members and subscription', async () => {
    const api = mockFetch([
      { match: '/admin/organisations/org_1/policy', body: { ok: false }, status: 404 },
      { match: '/admin/organisations/org_1/cost-caps', body: { ok: false }, status: 404 },
      { match: '/admin/organisations/org_1', body: orgDetail },
      { match: '/admin/organisations', body: { ok: true, total: 1, data: [orgRow] } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<OrganisationsTab />);
    expect(await screen.findByText('Crumb & Co')).toBeVisible();
    expect(screen.getByText('Past due')).toBeVisible();
    await user.type(screen.getByLabelText('Search organisations'), 'crumb');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.calls.some((c) => c.url.includes('q=crumb'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Open Crumb & Co' }));
    expect(await screen.findByText('ada@example.test')).toBeVisible();
    expect(screen.getByText('studio_standard_monthly')).toBeVisible();
    expect(screen.getByText(/Payment grace period ends/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /All organisations/ }));
    expect(await screen.findByLabelText('Search organisations')).toBeVisible();
  });
});

function userRoutes(impersonation: boolean, extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    {
      match: '/admin/users/u1',
      body: {
        ok: true,
        user: user1,
        memberships: [{ organisationId: 'org_1', organisationName: 'Crumb & Co', role: 'owner' }],
        impersonation,
      },
    },
    { match: '/admin/users', body: { ok: true, total: 1, data: [user1] } },
  ];
}

describe('UsersTab', () => {
  it('bans a user with a reason; no impersonation while it is off', async () => {
    const api = mockFetch(
      userRoutes(false, [
        {
          match: '/admin/users/u1/ban',
          method: 'POST',
          body: { ok: true, banned: true, sessionsRevoked: 2 },
        },
      ]),
    );
    const user = userEvent.setup();
    renderWithSWR(<UsersTab />);
    await user.click(await screen.findByRole('button', { name: 'Open Ada Baker' }));
    expect(await screen.findByText('Crumb & Co')).toBeVisible();
    expect(screen.queryByRole('button', { name: /View as this user/ })).toBeNull();
    expect(screen.getByText(/Viewing as a user is switched off/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Ban user/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'chargeback fraud');
    await user.click(within(dialog).getByRole('button', { name: 'Ban user' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url.endsWith('/ban'))?.body).toEqual({
        banned: true,
        reason: 'chargeback fraud',
      }),
    );
  });

  it('shows "View as this user" when impersonation is on', async () => {
    mockFetch(userRoutes(true));
    const user = userEvent.setup();
    renderWithSWR(<UsersTab />);
    await user.click(await screen.findByRole('button', { name: 'Open Ada Baker' }));
    expect(await screen.findByRole('button', { name: /View as this user/ })).toBeVisible();
  });
});

describe('SubscriptionsTab', () => {
  it('lists subscriptions read-only with counts and a status filter', async () => {
    const api = mockFetch([
      {
        match: '/admin/subscriptions',
        body: {
          ok: true,
          total: 1,
          byStatus: { past_due: 1, active: 4 },
          data: [
            {
              ...orgDetail.subscriptions[0],
              organisationName: 'Crumb & Co',
              graceUntil: '2026-10-05T00:00:00Z',
            },
          ],
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<SubscriptionsTab />);
    expect(await screen.findByText('Crumb & Co')).toBeVisible();
    expect(screen.getByText(/Read-only/)).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Status'), 'past_due');
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.includes('status=past_due'))).toBe(true),
    );
  });
});

describe('LegalReadinessWarning', () => {
  it('warns while terms and privacy are placeholders; silent once ready', async () => {
    mockFetch([
      {
        match: '/admin/legal-readiness',
        body: {
          ok: true,
          readiness: {
            ready: false,
            launchBlockers: ['terms', 'privacy'],
            docs: [
              { doc: 'terms', present: true, placeholder: true },
              { doc: 'privacy', present: false, placeholder: false },
              { doc: 'dpa', present: true, placeholder: false },
            ],
          },
          signups: { open: false, reason: 'legal_placeholder' },
        },
      },
    ]);
    const first = renderWithSWR(<LegalReadinessWarning />);
    expect(await screen.findByText('Legal documents are not ready for launch.')).toBeVisible();
    expect(screen.getByText('Terms of Service · placeholder')).toBeVisible();
    expect(screen.getByText('Privacy Policy · missing')).toBeVisible();
    expect(screen.getByText('Public sign-up is closed until then.')).toBeVisible();
    first.unmount();
    mockFetch([
      {
        match: '/admin/legal-readiness',
        body: {
          ok: true,
          readiness: { ready: true, launchBlockers: [], docs: [] },
          signups: { open: true },
        },
      },
    ]);
    const { container } = renderWithSWR(<LegalReadinessWarning />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows drafts with [[…]] details left as "details to fill in", with the hint', async () => {
    mockFetch([
      {
        match: '/admin/legal-readiness',
        body: {
          ok: true,
          readiness: {
            ready: false,
            launchBlockers: ['terms'],
            docs: [
              {
                doc: 'terms',
                present: true,
                placeholder: true,
                state: 'fill_in',
                unfilled: ['[[COMPANY LEGAL NAME]]'],
              },
              { doc: 'dpa', present: true, placeholder: true, state: 'placeholder', unfilled: [] },
            ],
          },
          signups: { open: false, reason: 'legal_placeholder' },
        },
      },
    ]);
    renderWithSWR(<LegalReadinessWarning />);
    expect(await screen.findByText('Terms of Service · details to fill in')).toBeVisible();
    expect(screen.getByText('Data Processing Agreement · placeholder')).toBeVisible();
    expect(screen.getByText(/Fill in the \[\[…\]\] details/)).toBeVisible();
  });
});

describe('admin tabs localised', () => {
  it('render in Arabic and Simplified Chinese', async () => {
    mockFetch(
      userRoutes(false, [
        { match: '/admin/organisations', body: { ok: true, total: 1, data: [orgRow] } },
      ]),
    );
    const ar = renderWithSWR(withLocale('ar', <OrganisationsTab />));
    expect(await screen.findByText('Crumb & Co')).toBeVisible();
    expect(document.documentElement.dir).toBe('rtl');
    ar.unmount();
    renderWithSWR(withLocale('zh-Hans', <UsersTab />));
    expect(await screen.findByText('Ada Baker')).toBeVisible();
    expect(document.documentElement.lang).toBe('zh-Hans');
  });
});
