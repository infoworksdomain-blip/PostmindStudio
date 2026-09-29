// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { BillingScreen } from './billing-screen';
import { billing, pricingView } from './test-fixtures';
import type { BillingResponse, InvoicesResponse } from './types';

const nav = vi.hoisted(() => ({ search: '', navigateTo: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/settings/billing',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('./navigate', () => ({ navigateTo: nav.navigateTo }));

const invoices: InvoicesResponse = {
  invoices: [
    {
      id: 'in_1',
      number: 'PM-0001',
      status: 'paid',
      amountDuePence: 20_900,
      currency: 'gbp',
      createdAt: '2026-09-01T10:00:00.000Z',
      hostedInvoiceUrl: 'https://invoice.stripe.test/i/in_1',
      invoicePdfUrl: 'https://invoice.stripe.test/i/in_1.pdf',
    },
  ],
};

function mockBilling(b: BillingResponse['billing'], extra: MockRoute[] = []) {
  return mockFetch([
    ...extra,
    { match: '/api/studio/billing/plans', body: { ok: true, pricing: pricingView() } },
    { match: '/api/studio/billing/invoices', body: { ok: true, ...invoices } },
    { match: /\/api\/studio\/billing$/, body: { ok: true, billing: b } },
  ]);
}

const base = billing();

beforeEach(() => {
  nav.search = '';
  nav.navigateTo.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('BillingScreen', () => {
  it('shows an active plan with renewal, usage, credits, invoices and Manage billing', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/portal',
        method: 'POST',
        body: { ok: true, url: 'https://portal.stripe.test/s' },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Standard plan')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Renews on 29 October 2026.')).toBeInTheDocument();
    expect(screen.getByText('Billed monthly')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Seats' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('meter', { name: 'Storage' })).toHaveAttribute(
      'aria-valuetext',
      '12 GB of 100 GB',
    );
    expect(screen.getByRole('meter', { name: 'Generation spend' })).toHaveAttribute(
      'aria-valuetext',
      '£45.00 of £150.00',
    );
    expect(screen.getByText('7 short video credits')).toBeInTheDocument();
    expect(screen.getByText('No long video credits')).toBeInTheDocument();
    // No plan picker while a subscription is live.
    expect(screen.queryByText('Choose a plan')).toBeNull();

    const table = await screen.findByRole('table', { name: 'Invoices' });
    const row = within(table).getByRole('row', { name: /PM-0001/ });
    expect(row).toHaveTextContent('£209.00');
    expect(row).toHaveTextContent('Paid');
    const view = within(row).getByRole('link', {
      name: 'View invoice PM-0001 (opens in a new tab)',
    });
    expect(view).toHaveAttribute('href', 'https://invoice.stripe.test/i/in_1');
    expect(view).toHaveAttribute('target', '_blank');
    expect(view).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      within(row).getByRole('link', {
        name: 'Download invoice PM-0001 as a PDF (opens in a new tab)',
      }),
    ).toHaveAttribute('href', 'https://invoice.stripe.test/i/in_1.pdf');

    await user.click(screen.getByRole('button', { name: 'Manage billing' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://portal.stripe.test/s'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/portal'))?.body).toEqual({
      returnPath: '/settings/billing',
    });
  });

  it('buys a top-up pack for the current tier through Checkout', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/checkout',
        method: 'POST',
        body: { ok: true, url: 'https://checkout.stripe.test/c' },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    // STANDARD sees its own short and long packs only.
    const buy = await screen.findByRole('button', { name: 'Buy 10 short videos for £39.00' });
    expect(
      screen.getByRole('button', { name: 'Buy 2 long videos for £39.00' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /£29\.00/ })).toBeNull();
    await user.click(buy);
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/c'),
    );
    const call = api.calls.find((c) => c.url.endsWith('/billing/checkout'))!;
    expect(call.body).toEqual({
      kind: 'topup',
      lookupKey: 'studio_topup_short10_standard',
      locale: 'en-GB',
    });
    expect(call.headers['idempotency-key']).toBeTruthy();
  });

  it('offers no long pack on BASIC', async () => {
    mockBilling(billing({ entitlements: { ...base.entitlements, tier: 'BASIC' } }));
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByRole('button', { name: 'Buy 10 short videos for £29.00' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /long videos/ })).toBeNull();
  });

  it('shows a trial with its end date', async () => {
    mockBilling(
      billing({
        entitlements: { ...base.entitlements, source: 'trial', subscriptionStatus: 'trialing' },
        subscription: {
          ...base.subscription!,
          status: 'trialing',
          trialEnd: '2026-10-13T12:00:00.000Z',
        },
      }),
    );
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Free trial')).toBeInTheDocument();
    expect(screen.getByText(/Your free trial ends on 13 October 2026/)).toBeInTheDocument();
  });

  it('shows past due with the grace countdown', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00.000Z'), toFake: ['Date'] });
    try {
      mockBilling(
        billing({
          entitlements: {
            ...base.entitlements,
            subscriptionStatus: 'past_due',
            graceUntil: '2026-10-03T12:00:00.000Z',
          },
          subscription: { ...base.subscription!, status: 'past_due' },
        }),
      );
      renderWithSWR(<BillingScreen />);
      expect(await screen.findByText('Payment failed')).toBeInTheDocument();
      expect(screen.getByText(/Update your payment method by 3 October 2026/)).toBeInTheDocument();
      expect(screen.getByText('4 days left')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows read-only access', async () => {
    mockBilling(
      billing({
        entitlements: { ...base.entitlements, access: 'read_only', subscriptionStatus: 'unpaid' },
        subscription: { ...base.subscription!, status: 'unpaid' },
      }),
    );
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText(/Your account is read-only/)).toBeInTheDocument();
  });

  it('shows cancelling at period end', async () => {
    mockBilling(billing({ subscription: { ...base.subscription!, cancelAtPeriodEnd: true } }));
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Cancelling')).toBeInTheDocument();
    expect(screen.getByText(/Your plan ends on 29 October 2026/)).toBeInTheDocument();
  });

  it('offers the plan picker with a trial to an organisation without a plan', async () => {
    const api = mockBilling(
      billing({
        entitlements: {
          ...base.entitlements,
          tier: 'BASIC',
          access: 'none',
          source: 'none',
          subscriptionStatus: null,
        },
        subscription: null,
        hasBillingAccount: false,
        trialEligible: true,
      }),
      [
        {
          match: '/billing/checkout',
          method: 'POST',
          body: { ok: true, url: 'https://checkout.stripe.test/s' },
        },
      ],
    );
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText(/doesn’t have a plan yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    // No packs without a plan.
    expect(screen.getByText(/Top-up packs are available on/)).toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: 'Annual' }));
    await user.click(await screen.findByRole('button', { name: 'Start free trial' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/s'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/checkout'))?.body).toEqual({
      kind: 'subscription',
      tier: 'STANDARD',
      interval: 'year',
      locale: 'en-GB',
    });
  });

  it('hides every billing button from non-owners', async () => {
    mockBilling(
      billing({
        canManage: false,
        subscription: null,
        entitlements: { ...base.entitlements, access: 'none', source: 'none' },
      }),
    );
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByText(/Only an organisation owner can change billing/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Buy/ })).toBeNull();
    expect(screen.queryByText('Choose a plan')).toBeNull();
  });

  it('shows the checkout return banner', async () => {
    nav.search = 'checkout=success';
    mockBilling(base);
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText(/Your plan is being set up/)).toBeInTheDocument();
  });

  it('explains when billing is not managed here (501)', async () => {
    mockFetch([
      {
        match: /\/api\/studio\/billing$/,
        status: 501,
        body: { ok: false, error: 'not_implemented', message: 'Billing is not enabled' },
      },
    ]);
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Billing isn’t managed here')).toBeInTheDocument();
  });
});
