// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { BillingScreen } from './billing-screen';
import { allowanceLeft } from './plan-summary';
import { billing, pricingView, usage } from './test-fixtures';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings/billing',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('allowanceLeft (25.12)', () => {
  it('counts what is left, never below zero, from quarters when given', () => {
    expect(allowanceLeft({ used: 5, limit: 8, percent: 63, maxDurationSec: null })).toBe(3);
    expect(allowanceLeft({ used: 9, limit: 8, percent: 100, maxDurationSec: null })).toBe(0);
    expect(
      allowanceLeft({
        used: 5.5,
        limit: 8,
        percent: 69,
        maxDurationSec: null,
        usedQuarters: 22,
        limitQuarters: 32,
      }),
    ).toBe(2.5);
    expect(allowanceLeft({ used: 3, limit: null, percent: null, maxDurationSec: null })).toBeNull();
  });
});

describe('Your plan summary (25.12)', () => {
  it('shows an honest "0 left" when the allowance is used up', async () => {
    mockFetch([
      { match: '/api/studio/billing/plans', body: { ok: true, pricing: pricingView() } },
      { match: '/api/studio/billing/invoices', body: { ok: true, invoices: [] } },
      { match: '/api/studio/usage', body: { ok: true, ...usage(8, 8) } },
      { match: /\/api\/studio\/billing$/, body: { ok: true, billing: billing() } },
    ]);
    renderWithSWR(<BillingScreen />);
    const summary = (await screen.findByText('Videos left this month')).closest('dl')!;
    expect(within(summary).getByText('0 of 8')).toBeInTheDocument();
    expect(await screen.findByText('0 left')).toBeInTheDocument();
    expect(within(summary).getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('No invoices yet.')).toBeInTheDocument();
  });
});
