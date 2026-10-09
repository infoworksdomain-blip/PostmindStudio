// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR, type MockRoute } from '../library/test-helpers';
import { BillingScreen } from './billing-screen';
import { billing, noPlan, pricingView, usage } from './test-fixtures';
import type { BillingResponse, InvoicesResponse } from './types';

// 26.1 "Your plan" (/settings/billing): the plan (Starter / Growth / Pro), period, price, renewal,
// videos used against the allowance and pack videos left; change the plan / period with a preview
// (upgrade now with the prorated amount, downgrade at period end); packs; cancel and resume; the
// Stripe portal only for payment details and invoices; no cost figures and no channels anywhere.

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
      amountDuePence: 6_900,
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

describe('Your plan (26.1)', () => {
  it('shows the plan, period, price, renewal, videos, packs and invoices; no costs', async () => {
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
    expect(screen.getByTestId('plan-headline')).toHaveTextContent('Growth, monthly');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getAllByText(/£69\.00 a month/).length).toBeGreaterThan(0);
    expect(screen.getByText('Renews on 29 October 2026.')).toBeInTheDocument();
    expect(await screen.findByRole('meter', { name: 'Used this month' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
    expect(screen.getAllByText('7 pack videos left').length).toBeGreaterThan(0);
    expect(screen.getByRole('meter', { name: 'Seats' })).toHaveAttribute('aria-valuenow', '2');
    // 26.1: every plan posts to every platform: no channel section, count or limit.
    expect(screen.queryByText('Your channels')).toBeNull();
    expect(container.textContent).not.toMatch(/channel/i);
    // 21.5: no generation cost, spend or budget for customers.
    expect(container.textContent).not.toMatch(/spend|budget|cap\b/i);
    expect(screen.queryByText(/Basic|Plus|Standard/)).toBeNull();

    const table = await screen.findByRole('table', { name: 'Invoices' });
    expect(within(table).getByRole('row', { name: /PM-0001/ })).toHaveTextContent('£69.00');

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
            current: { plan: 'growth', interval: 'month' },
            next: { plan: 'pro', interval: 'month' },
            nextPricePence: 14_900,
            currency: 'gbp',
            effectiveAt: '2026-09-29T12:00:00.000Z',
            dueNowPence: 8_000,
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
    // The change picker starts on the current plan.
    expect(await screen.findByRole('radio', { name: 'Growth' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: 'Pro' }));
    expect(
      await screen.findByText(
        'New price: £149.00 a month. Applies now: you pay £80.00 today for the rest of this period.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.url.includes('/billing/plan/preview?plan=pro&interval=month')),
    ).toBe(true);
    expect(screen.getByText(/A higher plan, or a longer period/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your new plan' });
    expect(within(dialog).getByText('Now: Growth, monthly')).toBeInTheDocument();
    expect(within(dialog).getByText('New: Pro, monthly')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Pay £80.00 and change' }));
    await waitFor(() =>
      expect(api.calls.find((c) => /\/billing\/plan$/.test(c.url))?.body).toEqual({
        plan: 'pro',
        interval: 'month',
        prorationDate: 1_790_000_000,
      }),
    );
    expect(
      api.calls.find((c) => /\/billing\/plan$/.test(c.url))?.headers['idempotency-key'],
    ).toBeTruthy();
  });

  it('downgrade: applies at the end of the period with nothing to pay now', async () => {
    const api = mockBilling(base, [
      {
        match: '/billing/plan/preview',
        body: {
          ok: true,
          preview: {
            timing: 'period_end',
            current: { plan: 'growth', interval: 'month' },
            next: { plan: 'starter', interval: 'week' },
            nextPricePence: 950,
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
    await user.click(await screen.findByRole('radio', { name: 'Weekly' }));
    await user.click(screen.getByRole('radio', { name: 'Starter' }));
    expect(
      await screen.findByText(
        'New price: £9.50 a week. Applies on 29 October 2026. Nothing to pay now.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.url.includes('/billing/plan/preview?plan=starter&interval=week')),
    ).toBe(true);
    expect(screen.getByText(/A lower plan, or a shorter period/)).toBeInTheDocument();
    expect(screen.getAllByText(/Weekly costs more than monthly/).length).toBeGreaterThan(0);
  });

  it('shows a change waiting for the period end and keeps the current plan', async () => {
    const api = mockBilling(
      billing({
        plan: {
          ...base.plan!,
          pending: { plan: 'starter', interval: 'month', effectiveAt: '2026-10-29T12:00:00.000Z' },
        },
      }),
      [{ match: '/billing/plan/scheduled', method: 'DELETE', body: { ok: true, cancelled: true } }],
    );
    const user = userEvent.setup();
    renderWithSWR(<BillingScreen />);
    expect(await screen.findByText('From 29 October 2026: Starter, monthly.')).toBeInTheDocument();
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
      await screen.findByRole('button', { name: 'Buy 5 HD videos for £17.00' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Use within 3 months, on any plan').length).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Buy 15 HD videos for £45.00' }));
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

  it('an organisation without a plan chooses a plan and period, then Checkout (trial once)', async () => {
    nav.search = 'plan=starter&interval=year';
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
    // Prefilled from /pricing: Starter, yearly.
    expect(await screen.findByRole('radio', { name: 'Starter' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Yearly' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('£290.00 a year')).toBeInTheDocument();
    expect(screen.getByText('2 months free: you save £58.00 a year')).toBeInTheDocument();
    expect(screen.getByText(/Your first 7 days are free, with 2 videos/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Pro' }));
    await user.click(screen.getByRole('button', { name: 'Start free trial' }));
    await waitFor(() =>
      expect(nav.navigateTo).toHaveBeenCalledWith('https://checkout.stripe.test/s'),
    );
    expect(api.calls.find((c) => c.url.endsWith('/billing/checkout'))?.body).toEqual({
      kind: 'plan',
      plan: 'pro',
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
