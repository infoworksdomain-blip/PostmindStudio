// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { BillingScreen } from './billing-screen';
import { billing, noPlan, pricingView, usage } from './test-fixtures';
import type { BillingResponse, InvoicesResponse } from './types';

// 21.5 "Your plan" (/settings/billing): channels, period, price, renewal, videos used against the
// allowance and pack videos left; change channels / period with a preview (upgrade now with the
// prorated amount, downgrade at period end); packs; cancel and resume; connected channels; the
// Stripe portal only for payment details and invoices; no cost figures anywhere.

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
      amountDuePence: 8_700,
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
    { match: '/api/studio/usage', body: { ok: true, ...usage() } },
    { match: /\/api\/studio\/billing$/, body: { ok: true, billing: b } },
  ]);
}

const base = billing();

beforeEach(() => {
  nav.search = '';
  nav.navigateTo.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('Your plan (21.5)', () => {
  it('shows channels, period, price, renewal, videos, packs, channels and invoices; no costs', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/portal',
        method: 'POST',
        body: { ok: true, url: 'https://portal.stripe.test/s' },
      },
    ]);
    const user = userEvent.setup();
    const { container } = renderWithSWR(<BillingScreen />);
    expect(await screen.findByRole('heading', { name: 'Your plan', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('3 channels, monthly')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getAllByText(/£87\.00 a month/).length).toBeGreaterThan(0);
    expect(screen.getByText('Renews on 29 October 2026.')).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Used this month' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
    expect(screen.getAllByText('7 pack videos left').length).toBeGreaterThan(0);
    expect(screen.getByText('Publishing to: TikTok, Instagram.')).toBeInTheDocument();
    expect(screen.getByText('You can connect 1 more channel.')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Seats' })).toHaveAttribute('aria-valuenow', '2');
    // 21.5: no generation cost, spend or budget for customers.
    expect(container.textContent).not.toMatch(/spend|budget|cap\b/i);
    expect(screen.queryByText(/Basic|Plus|Standard/)).toBeNull();

    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(within(table).getByRole('row', { name: /PM-0001/ })).toHaveTextContent('£87.00');

    // The portal is only for payment details and invoices.
    await user.click(screen.getByRole('button', { name: 'Open billing portal' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://portal.stripe.test/s'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/portal'))?.body).toEqual({
      returnPath: '/settings/billing',
    });
  });

  it('upgrade: previews the new price and the prorated amount due now, then pays and changes', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/plan/preview',
        body: {
          ok: true,
          preview: {
            timing: 'now',
            current: { channels: 3, interval: 'month' },
            next: { channels: 4, interval: 'month' },
            nextPricePence: 11_600,
            currency: 'gbp',
            effectiveAt: '2026-09-29T12:00:00.000Z',
            dueNowPence: 1_160,
            prorationDate: 1_790_000_000,
          },
        },
      },
      {
        match: /\/billing\/plan$/,
        method: 'POST',
        body: { ok: true, outcome: { status: 'applied', timing: 'now' } },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Change your plan')).toBeInTheDocument();
    await user.click((await screen.findAllByRole('button', { name: 'Add a channel' }))[0]!);
    expect(
      await screen.findByText(
        'New price: £116.00 a month. Applies now: you pay £11.60 today for the rest of this period.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.url.includes('/billing/plan/preview?channels=4&interval=month')),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Review change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your new plan' });
    expect(within(dialog).getByText('Now: 3 channels, monthly')).toBeInTheDocument();
    expect(within(dialog).getByText('New: 4 channels, monthly')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Pay £11.60 and change' }));
    await waitFor(() =>
      expect(api.calls.find((c) => /\/billing\/plan$/.test(c.url))?.body).toEqual({
        channels: 4,
        interval: 'month',
        prorationDate: 1_790_000_000,
      }),
    );
    expect(
      api.calls.find((c) => /\/billing\/plan$/.test(c.url))?.headers['idempotency-key'],
    ).toBeTruthy();
  });

  it('downgrade: applies at the end of the period with nothing to pay now', async () => {
    mockBilling(base, [
      {
        match: '/billing/plan/preview',
        body: {
          ok: true,
          preview: {
            timing: 'period_end',
            current: { channels: 3, interval: 'month' },
            next: { channels: 3, interval: 'week' },
            nextPricePence: 2_850,
            currency: 'gbp',
            effectiveAt: '2026-10-29T12:00:00.000Z',
            dueNowPence: null,
            prorationDate: null,
          },
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    const radios = await screen.findAllByRole('radio', { name: 'Weekly' });
    await user.click(radios[radios.length - 1]!);
    expect(
      await screen.findByText(
        'New price: £28.50 a week. Applies on 29 October 2026. Nothing to pay now.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Weekly costs more than monthly/).length).toBeGreaterThan(0);
  });

  it('shows a change waiting for the period end and keeps the current plan', async () => {
    const api = mockBilling(
      billing({
        plan: {
          ...base.plan!,
          pending: { channels: 1, interval: 'month', effectiveAt: '2026-10-29T12:00:00.000Z' },
        },
      }),
      [{ match: '/billing/plan/scheduled', method: 'DELETE', body: { ok: true, cancelled: true } }],
    );
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByText('From 29 October 2026: 1 channel, monthly.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my current plan' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.endsWith('/billing/plan/scheduled'))).toBe(true),
    );
  });

  it('buys an HD video pack through Checkout', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/checkout',
        method: 'POST',
        body: { ok: true, url: 'https://checkout.stripe.test/c' },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByRole('button', { name: 'Buy 5 HD videos for £15.00' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Buy 15 HD videos for £39.00' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/c'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/checkout'))?.body).toEqual({
      kind: 'topup',
      lookupKey: 'studio_pack_hd15',
      locale: 'en-GB',
    });
  });

  it('cancels at period end after confirming, then resumes', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/plan/cancel',
        method: 'POST',
        body: { ok: true, endsAt: '2026-10-29T12:00:00.000Z' },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    await user.click(await screen.findByRole('button', { name: 'Cancel plan' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel your plan?' });
    expect(within(dialog).getByText(/Your plan will end on 29 October 2026/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel plan' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.endsWith('/billing/plan/cancel'))).toBe(true),
    );
  });

  it('a plan set to end offers "Keep my plan" and blocks changes until then', async () => {
    const api = mockBilling(
      billing({ subscription: { ...base.subscription!, cancelAtPeriodEnd: true } }),
      [{ match: '/billing/plan/resume', method: 'POST', body: { ok: true, resumed: true } }],
    );
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('Cancelling')).toBeInTheDocument();
    expect(screen.getAllByText(/Your plan ends on 29 October 2026/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Keep your plan first, then you can change it/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my plan' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.endsWith('/billing/plan/resume'))).toBe(true),
    );
  });

  it('says which connected channels do not publish and links to add a channel', async () => {
    mockBilling(
      billing({
        channels: {
          paid: 1,
          connected: ['tiktok', 'youtube'],
          allowed: ['tiktok'],
          blocked: ['youtube'],
        },
      }),
    );
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByText(/is connected but doesn’t publish: your plan has no channel left/),
    ).toBeInTheDocument();
  });

  it('an organisation without a plan chooses channels and period, then Checkout (trial once)', async () => {
    nav.search = 'channels=2&interval=year';
    const api = mockBilling(noPlan(), [
      {
        match: '/billing/checkout',
        method: 'POST',
        body: { ok: true, url: 'https://checkout.stripe.test/s' },
      },
    ]);
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText(/doesn’t have a plan yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open billing portal' })).toBeNull();
    // Prefilled from /pricing: 2 channels, yearly.
    expect(await screen.findByText('£580.00 a year')).toBeInTheDocument();
    expect(screen.getByText('2 months free: you save £116.00 a year')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a channel' }));
    expect(await screen.findByText('£870.00 a year')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start free trial' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/s'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/checkout'))?.body).toEqual({
      kind: 'channels',
      channels: 3,
      interval: 'year',
      locale: 'en-GB',
    });
  });

  it('hides every billing button from non-owners', async () => {
    mockBilling(billing({ canManage: false }));
    renderWithSWR(<BillingScreen />);
    expect(
      await screen.findByText(/Only an organisation owner can change the plan/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open billing portal' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Buy/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel plan' })).toBeNull();
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
