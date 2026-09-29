// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/client/api';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { billing, pricingView } from './test-fixtures';
import { UpgradeDialogHost } from './upgrade-dialog';

// Phase 18 §3 — api() emits plan / billing blocks on the upgrade bus; the host opens the dialog.

const nav = vi.hoisted(() => ({ navigateTo: vi.fn() }));
vi.mock('./navigate', () => ({ navigateTo: nav.navigateTo }));

function routes(b = billing(), extra: MockRoute[] = []): MockRoute[] {
  return [
    ...extra,
    { match: '/api/studio/billing/plans', body: { ok: true, pricing: pricingView() } },
    { match: /\/api\/studio\/billing$/, body: { ok: true, billing: b } },
  ];
}

/** Fire a gated request through api() so the real emit path runs. */
async function block() {
  await act(async () => {
    await api('/gated', { method: 'POST', body: {} }).catch(() => undefined);
  });
}

function gated(status: number, error: string, details?: Record<string, unknown>): MockRoute {
  return {
    match: '/api/studio/gated',
    method: 'POST',
    status,
    body: { ok: false, error, message: 'blocked', details },
  };
}

beforeEach(() => nav.navigateTo.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe('UpgradeDialogHost', () => {
  it('stays closed until a plan or billing block', async () => {
    mockFetch(routes(billing(), [gated(404, 'not_found')]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('plan_tier names the required tier and its price; an owner without a subscription goes to Checkout', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(
      routes(billing({ subscription: null }), [
        gated(403, 'plan_tier', { requiredTier: 'PLUS' }),
        {
          match: '/billing/checkout',
          method: 'POST',
          body: { ok: true, url: 'https://checkout.stripe.test/p' },
        },
      ]),
    );
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    const dialog = await screen.findByRole('dialog', { name: 'Upgrade to Plus' });
    expect(dialog).toHaveTextContent('This feature is included from the Plus plan.');
    expect(await screen.findByText('Plus is £749.00 a month, excl. VAT.')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Upgrade' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/p'),
    );
    expect(calls.calls.find((c) => c.url.endsWith('/billing/checkout'))?.body).toEqual({
      kind: 'subscription',
      tier: 'PLUS',
      interval: 'month',
      locale: 'en-GB',
    });
  });

  it('plan_tier with a live subscription upgrades in the Customer Portal', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(billing(), [
        gated(403, 'plan_tier', { requiredTier: 'PLUS' }),
        {
          match: '/billing/portal',
          method: 'POST',
          body: { ok: true, url: 'https://portal.stripe.test/u' },
        },
      ]),
    );
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    await screen.findByRole('dialog', { name: 'Upgrade to Plus' });
    await user.click(await screen.findByRole('button', { name: 'Upgrade' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://portal.stripe.test/u'),
    );
  });

  it('quota_exceeded offers upgrade and a top-up', async () => {
    mockFetch(routes(billing(), [gated(403, 'quota_exceeded')]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    expect(
      await screen.findByRole('dialog', { name: 'You’ve reached this month’s limit' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buy top-up' })).toHaveAttribute(
      'href',
      '/settings/billing#topups',
    );
    expect(await screen.findByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
  });

  it('plan_required links to choosing a plan', async () => {
    mockFetch(routes(billing({ subscription: null }), [gated(402, 'plan_required')]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    expect(
      await screen.findByRole('dialog', { name: 'Choose a plan to start creating' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it('billing_required sends an owner to update the payment method', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(billing(), [
        gated(402, 'billing_required'),
        {
          match: '/billing/portal',
          method: 'POST',
          body: { ok: true, url: 'https://portal.stripe.test/pm' },
        },
      ]),
    );
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    await screen.findByRole('dialog', { name: 'Update your payment method' });
    await user.click(await screen.findByRole('button', { name: 'Update payment method' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://portal.stripe.test/pm'),
    );
  });

  it('asks a non-owner to find an owner and hides the Stripe buttons', async () => {
    const user = userEvent.setup();
    mockFetch(routes(billing({ canManage: false }), [gated(402, 'billing_required')]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    expect(await screen.findByText(/Ask an owner to do this/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update payment method' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
