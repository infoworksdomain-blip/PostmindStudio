// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { api } from '@/lib/client/api';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import { mockFetch } from '../library/test-helpers';
import { BillingScreen } from './billing-screen';
import { PricingScreen } from './pricing-screen';
import { billing, pricingView } from './test-fixtures';
import { UpgradeDialogHost } from './upgrade-dialog';

// Phase 18 §3 — pricing, billing and the upgrade dialog render from the ar (RTL) and zh-Hans
// catalogues (a missing key throws).

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('topup=success'),
  usePathname: () => '/settings/billing',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function swr(ui: ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>;
}

function mockBillingApi() {
  mockFetch([
    {
      match: '/api/studio/gated',
      method: 'POST',
      status: 403,
      body: {
        ok: false,
        error: 'plan_tier',
        message: 'blocked',
        details: { requiredTier: 'PLUS' },
      },
    },
    { match: '/api/studio/billing/plans', body: { ok: true, pricing: pricingView() } },
    { match: '/api/studio/billing/invoices', body: { ok: true, invoices: [] } },
    { match: /\/api\/studio\/billing$/, body: { ok: true, billing: billing() } },
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['ar', 'zh-Hans'] as const)('billing screens in %s', (locale) => {
  const m = ALL_MESSAGES[locale];

  it('renders /pricing', async () => {
    render(withLocale(locale, <PricingScreen pricing={pricingView()} />));
    expect(
      screen.getByRole('heading', { level: 1, name: m.pricing.hero.title }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: m.pricing.interval.year })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: m.pricing.compare.caption })).toBeInTheDocument();
    expect(screen.getByText(m.pricing.exclVat)).toBeInTheDocument();
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr'),
    );
    expect(document.documentElement).toHaveAttribute('lang', locale);
  });

  it('renders /settings/billing', async () => {
    mockBillingApi();
    render(withLocale(locale, swr(<BillingScreen />)));
    expect(await screen.findByRole('button', { name: m.billing.plan.manage })).toBeInTheDocument();
    expect(screen.getByText(m.billing.banners.topupSuccess)).toBeInTheDocument();
    expect(screen.getByText(m.billing.plan.status.active)).toBeInTheDocument();
  });

  it('renders the upgrade dialog', async () => {
    mockBillingApi();
    render(withLocale(locale, swr(<UpgradeDialogHost />)));
    await act(async () => {
      await api('/gated', { method: 'POST', body: {} }).catch(() => undefined);
    });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: m.upgrade.actions.notNow })).toBeInTheDocument();
  });
});
