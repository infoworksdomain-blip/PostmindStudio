// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../../library/test-helpers';
import type { AdminEntitlementsResponse, AdminSubscriptionsResponse } from '../../billing/types';
import { EntitlementsPanel } from './entitlements-panel';
import { SubscriptionsPanel } from './subscriptions-panel';

const view: AdminEntitlementsResponse['entitlements'] = {
  organisationId: 'org_1',
  effective: {
    tier: 'PLUS',
    access: 'full',
    source: 'stripe',
    limits: { seats: 15, businesses: 10, storageGb: 500 },
  },
  stored: {
    tier: 'PLUS',
    access: 'full',
    source: 'stripe',
    graceUntil: null,
    trialStartedAt: null,
    everPaidAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  },
  admin: null,
  limits: null,
  enterprise: { monthlyCapPence: 110_000, minimumMonthlyPricePence: 141_600 },
  subscriptions: [
    {
      id: 'sub_1',
      status: 'active',
      tier: 'PLUS',
      interval: 'month',
      currentPeriodEnd: '2026-10-20T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    },
  ],
};

const PATH = '/admin/organisations/org_1/entitlements';

async function openOrg() {
  const user = userEvent.setup();
  renderWithSWR(<EntitlementsPanel />);
  await user.type(screen.getByLabelText('Organisation id'), 'org_1');
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await screen.findByText('Effective plan');
  return user;
}

afterEach(() => vi.unstubAllGlobals());

describe('EntitlementsPanel', () => {
  it('shows the effective plan, stored row and subscriptions', async () => {
    mockFetch([{ match: PATH, body: { ok: true, entitlements: view } }]);
    await openOrg();
    expect(screen.getByText('Stripe')).toBeInTheDocument();
    expect(screen.getByText('No staff override.')).toBeInTheDocument();
    expect(screen.getByText(/Plus · Monthly · ends 20 Oct 2026/)).toBeInTheDocument();
  });

  it('blocks an ENTERPRISE save below the minimum price, then PUTs the right body', async () => {
    const api = mockFetch([
      { match: PATH, body: { ok: true, entitlements: view } },
      {
        match: PATH,
        method: 'PUT',
        body: {
          ok: true,
          entitlements: { ...view, effective: { ...view.effective, tier: 'ENTERPRISE' } },
        },
      },
    ]);
    const user = await openOrg();
    await user.selectOptions(screen.getByLabelText('Tier'), 'ENTERPRISE');
    expect(
      screen.getByText('Minimum for this organisation’s £1,100.00 monthly cost cap: £1,416.00.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason (required)'), 'Signed enterprise deal');
    const save = screen.getByRole('button', { name: 'Save override' });
    expect(screen.getByRole('alert')).toHaveTextContent('needs the agreed monthly price');
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Agreed monthly price (£, excl. VAT)'), '1400');
    expect(screen.getByRole('alert')).toHaveTextContent('below the minimum of £1,416.00');
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText('Agreed monthly price (£, excl. VAT)'));
    await user.type(screen.getByLabelText('Agreed monthly price (£, excl. VAT)'), '1500');
    await user.type(screen.getByLabelText('Seats'), '40');
    await user.click(screen.getByRole('checkbox', { name: 'Short videos a month: unlimited' }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      tier: 'ENTERPRISE',
      limits: { seats: 40, shortVideos: null },
      monthlyPricePence: 150_000,
      expiresAt: null,
      reason: 'Signed enterprise deal',
    });
  });

  it('removes an override with a reason', async () => {
    const withOverride = {
      ...view,
      admin: {
        tier: 'ENTERPRISE' as const,
        reason: 'Pilot',
        setByUserId: 'staff_1',
        setAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null,
        monthlyPricePence: 150_000,
      },
    };
    const api = mockFetch([
      { match: PATH, body: { ok: true, entitlements: withOverride } },
      { match: PATH, method: 'DELETE', body: { ok: true, entitlements: view } },
    ]);
    const user = await openOrg();
    expect(screen.getByText('Reason: Pilot')).toBeInTheDocument();
    expect(screen.getByText('Agreed price: £1,500.00 a month')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reason for removing'), 'Pilot ended');
    await user.click(screen.getByRole('button', { name: 'Remove override' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(api.calls.find((c) => c.method === 'DELETE')?.body).toEqual({ reason: 'Pilot ended' });
    expect(await screen.findByText('No staff override.')).toBeInTheDocument();
  });
});

const subs: AdminSubscriptionsResponse = {
  summary: {
    mrrPence: 76_783,
    currency: 'gbp',
    byStatus: { active: 3, past_due: 1, trialing: 1 },
    byTier: {
      BASIC: { count: 1, mrrPence: 2_900 },
      STANDARD: { count: 2, mrrPence: 9_900 },
      PLUS: { count: 2, mrrPence: 63_983 },
      ENTERPRISE: { count: 0, mrrPence: 0 },
    },
    total: 5,
  },
  subscriptions: [
    {
      id: 'sub_1',
      organisationId: 'org_1',
      organisationName: 'Acme Coffee',
      status: 'past_due',
      tier: 'PLUS',
      interval: 'year',
      mrrPence: 29_083,
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
      trialEnd: null,
    },
  ],
};

describe('SubscriptionsPanel', () => {
  it('shows MRR, counts by tier and status, and the list; filters by status', async () => {
    const api = mockFetch([{ match: '/admin/billing/subscriptions', body: { ok: true, ...subs } }]);
    const user = userEvent.setup();
    renderWithSWR(<SubscriptionsPanel />);
    expect(await screen.findByText('£767.83')).toBeInTheDocument();
    expect(screen.getByText('5 subscriptions')).toBeInTheDocument();
    const byTier = screen.getByRole('list', { name: 'Subscriptions by tier' });
    expect(within(byTier).getByText('Plus').closest('li')).toHaveTextContent('2 · £639.83');
    const byStatus = screen.getByRole('list', { name: 'Subscriptions by status' });
    expect(within(byStatus).getByText('Past due').closest('li')).toHaveTextContent('1');
    const row = screen.getByRole('row', { name: /Acme Coffee/ });
    expect(row).toHaveTextContent('Annual');
    expect(row).toHaveTextContent('£290.83');
    expect(row).toHaveTextContent('Cancelling');

    await user.selectOptions(screen.getByLabelText('Status'), 'past_due');
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.includes('status=past_due'))).toBe(true),
    );
  });
});
