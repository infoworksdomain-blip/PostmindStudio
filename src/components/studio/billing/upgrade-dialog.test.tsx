// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/client/api';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { billing, pricingView } from './test-fixtures';
import { UpgradeDialogHost } from './upgrade-dialog';

// Phase 18 §3 / 26.1 — api() emits plan / billing blocks on the upgrade bus; the host
// opens the dialog. No internal tier names (plans are Starter / Growth / Pro).

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

  it('plan_tier never names a tier: "not included in your plan" (21.5)', async () => {
    mockFetch(routes(billing(), [gated(403, 'plan_tier', { requiredTier: 'PLUS' })]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    const dialog = await screen.findByRole('dialog', { name: 'Not included in your plan' });
    expect(dialog).toHaveTextContent('This feature isn’t part of your plan.');
    expect(dialog).not.toHaveTextContent(/Plus|Standard|Basic|£/);
    expect(screen.getByRole('link', { name: 'See the plan' })).toHaveAttribute('href', '/pricing');
  });

  it('26.1: every plan posts to every platform, so channel_limit never opens the dialog', async () => {
    mockFetch(routes(billing(), [gated(403, 'channel_limit', { platform: 'youtube' })]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a seat limit is not a monthly limit: seat wording, members, no video pack', async () => {
    mockFetch(
      routes(billing(), [
        gated(403, 'quota_exceeded', { reason: 'seat_limit', used: 2, limit: 2 }),
      ]),
    );
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    const dialog = await screen.findByRole('dialog', { name: 'Every seat on your plan is in use' });
    expect(dialog).not.toHaveTextContent('month');
    expect(screen.queryByRole('link', { name: 'Buy a video pack' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage members' })).toHaveAttribute(
      'href',
      '/settings/members',
    );
  });

  it('quota_exceeded offers a video pack or a higher plan', async () => {
    mockFetch(routes(billing(), [gated(403, 'quota_exceeded')]));
    renderWithSWR(<UpgradeDialogHost />);
    await block();
    const dialog = await screen.findByRole('dialog', {
      name: 'You’ve used your plan’s videos for now',
    });
    expect(dialog).toHaveTextContent(
      'Upgrade your plan for more videos each week or month, or buy a video pack to keep going today.',
    );
    expect(dialog).not.toHaveTextContent(/channel/i);
    expect(screen.getByRole('link', { name: 'Buy a video pack' })).toHaveAttribute(
      'href',
      '/settings/billing#topups',
    );
    expect(screen.getByRole('link', { name: 'Upgrade your plan' })).toHaveAttribute(
      'href',
      '/settings/billing#change',
    );
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
