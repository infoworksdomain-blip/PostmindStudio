// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { BusinessProvider } from '../business-context';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { AccountBanners, BillingBanner } from './account-banners';
import { AccountControls } from './account-menu';
import type { Me } from './use-me';

// Phase 18 Track E — the AppShell's organisation switcher, user menu with sign-out, and the
// account-state banners (trial, past due, read-only, no plan, impersonation).

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const me = (over: Partial<Me> = {}): Me => ({
  user: { id: 'u1', name: 'Ada Baker', email: 'ada@example.test', platformRole: 'user' },
  organisation: { id: 'org_1', name: 'Crumb & Co', role: 'owner' },
  organisations: [
    { id: 'org_1', name: 'Crumb & Co', role: 'owner' },
    { id: 'org_2', name: 'Harbour Coffee', role: 'creator' },
  ],
  plan: { tier: 'STANDARD', access: 'full', source: 'stripe' },
  banner: null,
  impersonating: false,
  identityMode: 'standalone',
  ...over,
});

function controls() {
  return (
    <BusinessProvider initial="biz_1">
      <AccountControls />
    </BusinessProvider>
  );
}

describe('AccountControls', () => {
  it('switches the active organisation through Better Auth and reloads', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const api = mockFetch([
      { match: '/api/auth/organization/set-active', method: 'POST', body: { ok: true } },
      { match: '/api/studio/me', body: { ok: true, me: me() } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(controls());
    await user.click(await screen.findByRole('button', { name: /Organisation: Crumb & Co/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Harbour Coffee' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/projects'));
    expect(api.calls.find((c) => c.url.includes('set-active'))?.body).toEqual({
      organizationId: 'org_2',
    });
  });

  it('signs out from the user menu', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mockFetch([
      { match: '/api/auth/sign-out', method: 'POST', body: { success: true } },
      { match: '/api/studio/me', body: { ok: true, me: me() } },
    ]);
    const user = userEvent.setup();
    renderWithSWR(controls());
    await user.click(await screen.findByRole('button', { name: 'Account menu for Ada Baker' }));
    expect(screen.getByText('ada@example.test')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Billing/ })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    await user.click(await screen.findByRole('menuitem', { name: /Sign out/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('core mode: no switcher and no sign-out (Core signs people in)', async () => {
    mockFetch([{ match: '/api/studio/me', body: { ok: true, me: me({ identityMode: 'core' }) } }]);
    const user = userEvent.setup();
    renderWithSWR(controls());
    expect(await screen.findByText('Crumb & Co')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Organisation:/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Account menu for Ada Baker' }));
    expect(screen.queryByRole('menuitem', { name: /Sign out/ })).toBeNull();
  });
});

describe('account banners', () => {
  const NOW = Date.parse('2026-10-01T12:00:00Z');

  it('trial shows days left, read-only and past due link to billing', () => {
    const { rerender } = renderWithSWR(
      <BillingBanner banner={{ kind: 'trial', endsAt: '2026-10-04T12:00:00Z' }} now={NOW} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Your free trial ends in 3 days.');
    rerender(<BillingBanner banner={{ kind: 'read_only' }} now={NOW} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your account is read-only.');
    expect(screen.getByRole('link', { name: 'Update payment' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    rerender(
      <BillingBanner banner={{ kind: 'past_due', graceUntil: '2026-10-05T00:00:00Z' }} now={NOW} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Everything works until 5 October');
    rerender(<BillingBanner banner={{ kind: 'no_plan' }} now={NOW} />);
    expect(screen.getByRole('link', { name: 'See plans' })).toBeVisible();
  });

  it('a cancelled organisation is told its subscription ended, not that payment is overdue (19.5)', () => {
    const { rerender } = renderWithSWR(
      <BillingBanner banner={{ kind: 'cancelled', deletesAt: '2026-12-30T00:00:00Z' }} now={NOW} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Your subscription has ended');
    expect(alert).toHaveTextContent('export your data');
    expect(alert).toHaveTextContent('deleted after 30 December 2026');
    expect(alert).not.toHaveTextContent(/overdue/i);
    expect(screen.getByRole('link', { name: 'Subscribe again' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    rerender(<BillingBanner banner={{ kind: 'cancelled', deletesAt: null }} now={NOW} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('deleted after');
  });

  it('shows the impersonation banner above the billing one', async () => {
    mockFetch([
      {
        match: '/api/studio/me',
        body: { ok: true, me: me({ impersonating: true, banner: { kind: 'read_only' } }) },
      },
    ]);
    renderWithSWR(<AccountBanners now={NOW} />);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('You are viewing Studio as Ada Baker');
    expect(alerts[1]).toHaveTextContent('read-only');
  });

  it('render in Arabic and Simplified Chinese', () => {
    const ar = renderWithSWR(
      withLocale(
        'ar',
        <BillingBanner banner={{ kind: 'trial', endsAt: '2026-10-03T12:00:00Z' }} now={NOW} />,
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent('يومين');
    expect(document.documentElement.dir).toBe('rtl');
    ar.unmount();
    renderWithSWR(
      withLocale('zh-Hans', <BillingBanner banner={{ kind: 'read_only' }} now={NOW} />),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/[一-鿿]/);
  });
});
