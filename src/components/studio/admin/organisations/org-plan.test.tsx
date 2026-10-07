// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR, type MockRoute } from '../../library/test-helpers';
import type { AdminEntitlementsResponse } from '../../billing/types';
import { EntitlementsPanel } from '../billing/entitlements-panel';
import { OrganisationSettings } from '../organisation-panel';
import { OrganisationsTab, type AdminOrgRow } from './organisations-tab';

// 20.27 (operator 2026-10-03): staff change an organisation's plan, access and trial from the
// Organisations tab: the list shows the trial, the detail shows the plan, the trial and its cost,
// the override form ends the trial after a confirmation, access none / read-only ask first,
// removing an override warns that a paused trial comes back, and cost caps clear to the plan.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom has no ResizeObserver; the Radix Switch in the review policy form measures with it.
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
  vi.clearAllMocks();
});

const ORG = 'org_op';
const ENT = `/admin/organisations/${ORG}/entitlements`;

const row: AdminOrgRow = {
  id: ORG,
  name: 'Operator Ltd',
  slug: 'operator',
  country: 'GB',
  createdAt: '2026-09-29T00:00:00Z',
  deletedAt: null,
  members: 1,
  tier: 'STANDARD',
  access: 'full',
  source: 'trial',
  trial: { state: 'running', endsAt: '2026-10-13T00:00:00Z' },
  channelPlan: { channels: 3, interval: 'month', source: 'stripe' },
  subscriptionStatus: 'trialing',
  costThisMonthPence: 1_499,
};

const trialing: AdminEntitlementsResponse['entitlements'] = {
  organisationId: ORG,
  effective: {
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    limits: { seats: 5, businesses: 3, storageGb: 100 },
  },
  stored: {
    tier: 'STANDARD',
    access: 'full',
    source: 'trial',
    graceUntil: null,
    trialStartedAt: '2026-09-29T00:00:00Z',
    everPaidAt: null,
    updatedAt: '2026-09-29T00:00:00Z',
  },
  admin: null,
  limits: null,
  trial: {
    state: 'running',
    startedAt: '2026-09-29T00:00:00Z',
    endsAt: '2026-10-13T00:00:00Z',
    endedAt: null,
    endedByUserId: null,
    dailyCostCapPence: 1_000,
    totalCostCapPence: 1_500,
    spentPence: 1_499,
  },
  enterprise: { monthlyCapPence: 110_000, minimumMonthlyPricePence: 141_600 },
  subscriptions: [],
};

const ended: AdminEntitlementsResponse['entitlements'] = {
  ...trialing,
  effective: { ...trialing.effective, tier: 'PLUS', source: 'admin' },
  admin: {
    tier: 'PLUS',
    reason: 'Operator account',
    setByUserId: 'staff-1',
    setAt: '2026-10-03T10:00:00Z',
    expiresAt: null,
    monthlyPricePence: null,
  },
  trial: {
    ...trialing.trial!,
    state: 'ended',
    endedAt: '2026-10-03T10:00:00Z',
    endedByUserId: 'staff-1',
  },
};

const costCaps = (override: { dailyPence: number | null; monthlyPence: number | null } | null) => ({
  ok: true,
  organisationId: ORG,
  caps: {
    daily: {
      pence: override?.dailyPence ?? null,
      source: override?.dailyPence ? 'org_override' : 'plan_tier',
      byTier: { PLUS: { pence: 2_000, source: 'default' } },
    },
    monthly: {
      pence: override?.monthlyPence ?? null,
      source: override?.monthlyPence ? 'org_override' : 'plan_tier',
      byTier: { PLUS: { pence: 26_400, source: 'default' } },
    },
  },
  override: override && {
    ...override,
    reason: 'Launch week',
    updatedByUserId: 'staff-1',
    updatedAt: '2026-10-02T00:00:00Z',
  },
});

const policy = {
  ok: true,
  organisationId: ORG,
  policy: {
    defaultReviewPolicy: 'REQUIRE_APPROVAL',
    autoApproveTrustThreshold: null,
    autoApproveAllowed: true,
  },
  source: {
    defaultReviewPolicy: 'default',
    autoApproveTrustThreshold: 'default',
    autoApproveAllowed: 'default',
  },
  updatedAt: null,
};

function routes(extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: ENT, body: { ok: true, entitlements: trialing } },
    { match: `/admin/organisations/${ORG}/policy`, body: policy },
    { match: `/admin/organisations/${ORG}/cost-caps`, body: costCaps(null) },
    {
      match: `/admin/organisations/${ORG}`,
      body: {
        ok: true,
        organisation: { ...row, defaultLocale: 'en-GB' },
        members: [],
        pendingInvitations: 0,
        businesses: 1,
        entitlement: {
          tier: 'STANDARD',
          access: 'full',
          source: 'trial',
          trial: row.trial,
          channelPlan: row.channelPlan,
          graceUntil: null,
          trialStartedAt: '2026-09-29T00:00:00Z',
          everPaidAt: null,
          reason: null,
          updatedAt: '2026-09-29T00:00:00Z',
        },
        subscriptions: [],
        costThisMonthPence: 1_499,
      },
    },
    {
      match: '/admin/organisations',
      body: { ok: true, total: 1, offset: 0, pageSize: 50, data: [row] },
    },
  ];
}

// Many typed fields and a dialog: slow in a loaded jsdom run, so a longer timeout.
describe('Organisations tab: plan, trial and caps (20.27)', { timeout: 45_000 }, () => {
  it('lists the trial, opens the organisation, and ends the trial with a PLUS override after confirming', async () => {
    const api = mockFetch(
      routes([{ match: ENT, method: 'PUT', body: { ok: true, entitlements: ended } }]),
    );
    const user = userEvent.setup();
    renderWithSWR(<OrganisationsTab />);
    const listRow = await screen.findByRole('row', { name: /Operator Ltd/ });
    expect(listRow).toHaveTextContent('Until 13 Oct 2026');
    expect(listRow).toHaveTextContent('£14.99');
    expect(listRow).toHaveTextContent(ORG);
    // 21.5: the channel plan sits beside the tier.
    expect(within(listRow).getByTestId('org-channel-plan')).toHaveTextContent(
      '3 channels · monthly',
    );

    await user.click(screen.getByRole('button', { name: 'Open Operator Ltd' }));
    expect(await screen.findByRole('heading', { name: 'Plan, access and trial' })).toBeVisible();
    const trial = await screen.findByTestId('trial-summary');
    expect(trial).toHaveTextContent('Running: the trial’s caps apply now.');
    expect(trial).toHaveTextContent(
      'AI cost since the trial started: £14.99 of £15.00 (at most £10.00 a day)',
    );
    expect(within(trial).getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
    // The cost caps form sits on the same page.
    expect(await screen.findByRole('form', { name: 'Cost cap overrides' })).toBeVisible();

    const form = screen.getByRole('form', { name: 'Set an override' });
    await user.selectOptions(within(form).getByLabelText('Tier'), 'PLUS');
    await user.click(within(form).getByRole('checkbox', { name: 'End the trial now' }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Operator account');
    await user.click(within(form).getByRole('button', { name: 'Save override' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Ending the trial cannot be undone');
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      tier: 'PLUS',
      expiresAt: null,
      endTrial: true,
      reason: 'Operator account',
    });
    expect(await screen.findByText(/Ended by staff on/)).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'End the trial now' })).toBeNull();
  });

  it('access none asks for confirmation; cancelling sends nothing', async () => {
    const api = mockFetch(routes());
    const user = userEvent.setup();
    renderWithSWR(<EntitlementsPanel />);
    await user.type(screen.getByLabelText('Organisation id'), ORG);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const form = await screen.findByRole('form', { name: 'Set an override' });
    await user.selectOptions(within(form).getByLabelText('Access'), 'none');
    await user.type(within(form).getByLabelText('Reason (required)'), 'Chargeback');
    await user.click(within(form).getByRole('button', { name: 'Save override' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Access None stops everyone in this organisation');
    expect(dialog).not.toHaveTextContent('Ending the trial');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a tier-only override saves without a dialog', async () => {
    const api = mockFetch(
      routes([{ match: ENT, method: 'PUT', body: { ok: true, entitlements: ended } }]),
    );
    const user = userEvent.setup();
    renderWithSWR(<EntitlementsPanel />);
    await user.type(screen.getByLabelText('Organisation id'), ORG);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const form = await screen.findByRole('form', { name: 'Set an override' });
    expect(within(form).getByText(/Any saved override pauses the trial’s caps/)).toBeVisible();
    await user.selectOptions(within(form).getByLabelText('Tier'), 'PLUS');
    await user.type(within(form).getByLabelText('Reason (required)'), 'Goodwill');
    await user.click(within(form).getByRole('button', { name: 'Save override' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      tier: 'PLUS',
      expiresAt: null,
      reason: 'Goodwill',
    });
  });

  it('21.5: the organisation page sets channels and a yearly interval', async () => {
    const yearly: AdminEntitlementsResponse['entitlements'] = {
      ...ended,
      effective: {
        ...trialing.effective,
        source: 'admin',
        channelPlan: { channels: 2, interval: 'year', source: 'admin' },
      },
      admin: {
        channels: 2,
        interval: 'year',
        reason: 'Annual deal',
        setByUserId: 'staff-1',
        setAt: '2026-10-04T10:00:00Z',
        expiresAt: null,
        monthlyPricePence: null,
      },
      trial: { ...trialing.trial!, state: 'overridden' },
    };
    const api = mockFetch(
      routes([{ match: ENT, method: 'PUT', body: { ok: true, entitlements: yearly } }]),
    );
    const user = userEvent.setup();
    renderWithSWR(<OrganisationsTab />);
    await user.click(await screen.findByRole('button', { name: 'Open Operator Ltd' }));
    const form = await screen.findByRole('form', { name: 'Set an override' });
    expect(screen.getByText('No channel plan')).toBeVisible();
    await user.selectOptions(within(form).getByLabelText('Channels'), '2');
    await user.selectOptions(within(form).getByLabelText('Billing interval'), 'year');
    await user.type(within(form).getByLabelText('Reason (required)'), 'Annual deal');
    await user.click(within(form).getByRole('button', { name: 'Save override' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
      channels: 2,
      interval: 'year',
      expiresAt: null,
      reason: 'Annual deal',
    });
    expect(await screen.findByTestId('channel-plan')).toHaveTextContent(
      '2 channels · yearly (set by staff)',
    );
  });

  it('removing an override that pauses a trial warns that the trial caps come back', async () => {
    const paused = {
      ...ended,
      trial: { ...trialing.trial!, state: 'overridden' as const },
    };
    mockFetch([{ match: ENT, body: { ok: true, entitlements: paused } }]);
    const user = userEvent.setup();
    renderWithSWR(<EntitlementsPanel />);
    await user.type(screen.getByLabelText('Organisation id'), ORG);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const remove = await screen.findByRole('form', { name: 'Remove the override' });
    expect(within(remove).getByRole('note')).toHaveTextContent(
      'removing the override brings the trial’s caps back',
    );
    expect(screen.getByText(/Paused by the staff override/)).toBeVisible();
  });
});

describe('Cost caps: clear back to the plan default (20.27)', () => {
  it('sends both caps as null with the reason', async () => {
    const api = mockFetch([
      { match: `/admin/organisations/${ORG}/cost-caps`, method: 'PUT', body: { ok: true } },
      {
        match: `/admin/organisations/${ORG}/cost-caps`,
        body: costCaps({ dailyPence: 5_000, monthlyPence: 50_000 }),
      },
      { match: `/admin/organisations/${ORG}/policy`, body: policy },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<OrganisationSettings orgId={ORG} />);
    const caps = await screen.findByRole('form', { name: 'Cost cap overrides' });
    const clear = await within(caps).findByRole('button', { name: 'Clear back to plan default' });
    expect(clear).toBeDisabled(); // a reason is required
    await user.type(within(caps).getByLabelText(/Reason/), 'Trial over, plan caps');
    await user.click(clear);
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({
        dailyPence: null,
        monthlyPence: null,
        reason: 'Trial over, plan caps',
      }),
    );
  });

  it('has no clear button without an override', async () => {
    mockFetch([
      { match: `/admin/organisations/${ORG}/cost-caps`, body: costCaps(null) },
      { match: `/admin/organisations/${ORG}/policy`, body: policy },
    ]);
    renderWithSWR(<OrganisationSettings orgId={ORG} />);
    const caps = await screen.findByRole('form', { name: 'Cost cap overrides' });
    expect(within(caps).queryByRole('button', { name: 'Clear back to plan default' })).toBeNull();
  });
});

describe('Organisations tab in Arabic (RTL)', () => {
  it('shows the trial column and the end-trial option in Arabic', async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    renderWithSWR(withLocale('ar', <OrganisationsTab />));
    expect(await screen.findByText('Operator Ltd')).toBeVisible();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('columnheader', { name: 'التجربة' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Operator Ltd/ }));
    expect(await screen.findByRole('checkbox', { name: 'إنهاء التجربة الآن' })).toBeInTheDocument();
  });
});
