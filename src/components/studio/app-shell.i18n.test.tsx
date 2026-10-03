// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { LOCALE_COOKIE } from '@/lib/i18n/locales';
import { AppShell } from './app-shell';
import { BusinessProvider } from './business-context';
import { StudioIntlProvider } from './i18n/intl-provider';
import { ALL_MESSAGES } from '@/lib/i18n/all-messages';
import { mockFetch, renderWithSWR } from './library/test-helpers';

// BACKLOG 16.4 — the app shell renders from the catalogue in en-GB, ar (RTL) and zh-Hans, and the
// language switcher persists the choice.

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function shell() {
  return (
    <BusinessProvider initial="biz_1">
      <AppShell>
        <p>screen</p>
      </AppShell>
    </BusinessProvider>
  );
}

function mockShellApi() {
  mockFetch([
    {
      match: '/notifications',
      body: { ok: true, unreadCount: 2, nextCursor: null, data: [] },
    },
    { match: '/businesses', body: { ok: true, data: [] } },
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = `${LOCALE_COOKIE}=; Max-Age=0; Path=/`;
});

describe('AppShell localisation', () => {
  it('renders navigation from the en-GB catalogue', async () => {
    mockShellApi();
    renderWithSWR(withLocale('en-GB', shell()));
    const nav = screen.getAllByRole('navigation', { name: 'Studio' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Reference library' })).toBeInTheDocument();
    // /me is not mocked here, so the account is unknown: no staff section (it shows only to staff).
    expect(within(nav).queryByText('PostMind staff')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement).toHaveAttribute('lang', 'en-GB');
  });

  it('renders Arabic right-to-left with Arabic plurals', async () => {
    mockShellApi();
    renderWithSWR(withLocale('ar', shell()));
    const nav = screen.getAllByRole('navigation', {
      name: ALL_MESSAGES.ar.shell.nav.ariaLabel,
    })[0]!;
    expect(
      within(nav).getByRole('link', { name: ALL_MESSAGES.ar.shell.nav.items.library }),
    ).toBeInTheDocument();
    // two → the Arabic dual form, not "# unread".
    expect(
      await screen.findByRole('button', { name: 'الإشعارات، إشعاران غير مقروءين' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
  });

  it('renders Simplified Chinese', async () => {
    mockShellApi();
    renderWithSWR(withLocale('zh-Hans', shell()));
    expect(
      screen.getAllByRole('link', { name: ALL_MESSAGES['zh-Hans'].shell.nav.items.projects })
        .length,
    ).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: '通知，2 条未读' })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans'));
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
  });

  it('switches language from the header listbox and stores the choice in the cookie', async () => {
    mockShellApi();
    const user = userEvent.setup();
    const onLocaleChange = vi.fn();
    renderWithSWR(
      <StudioIntlProvider
        locale="en-GB"
        messages={ALL_MESSAGES['en-GB']}
        onLocaleChange={onLocaleChange}
        missingKeys="throw"
      >
        {shell()}
      </StudioIntlProvider>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Interface language: English (UK)' }));
    const listbox = await screen.findByRole('listbox');
    const french = within(listbox).getByRole('option', { name: 'Français' });
    expect(french).toHaveAttribute('lang', 'fr');
    expect(within(listbox).getByRole('option', { name: 'العربية' })).toHaveAttribute('dir', 'rtl');
    await user.click(french);
    expect(onLocaleChange).toHaveBeenCalledWith('fr');
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=fr`);
  });
});

describe('AppShell staff navigation (Phase 18)', () => {
  const me = (platformRole: string) => ({
    ok: true,
    me: {
      user: { id: 'u1', name: 'A', email: 'a@example.test', platformRole },
      organisation: { id: 'o1', name: 'Org', slug: 'org', role: 'owner' },
      organisations: [{ id: 'o1', name: 'Org', slug: 'org', role: 'owner' }],
      plan: null,
      banner: null,
      impersonating: false,
      identityMode: 'standalone',
    },
  });

  it('hides the staff section from a standalone user who is not staff', async () => {
    mockFetch([
      { match: '/api/studio/me', body: me('user') },
      { match: '/notifications', body: { ok: true, unreadCount: 0, nextCursor: null, data: [] } },
      { match: '/businesses', body: { ok: true, local: true, data: [] } },
    ]);
    renderWithSWR(withLocale('en-GB', shell()));
    const nav = screen.getAllByRole('navigation', { name: 'Studio' })[0]!;
    await waitFor(() => expect(within(nav).queryByText('PostMind staff')).not.toBeInTheDocument());
    expect(within(nav).queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument();
  });

  it('hides the staff section when /me fails for any reason, not only no_organisation', async () => {
    mockFetch([
      {
        match: '/api/studio/me',
        status: 403,
        body: { ok: false, error: { code: 'plan_required', message: 'Choose a plan' } },
      },
      { match: '/notifications', body: { ok: true, unreadCount: 0, nextCursor: null, data: [] } },
      { match: '/businesses', body: { ok: true, local: true, data: [] } },
    ]);
    renderWithSWR(withLocale('en-GB', shell()));
    const nav = screen.getAllByRole('navigation', { name: 'Studio' })[0]!;
    expect(await within(nav).findByRole('link', { name: 'Projects' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(nav).queryByText('PostMind staff')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /Admin/ })).not.toBeInTheDocument();
  });

  it('shows the staff section to platform staff', async () => {
    mockFetch([
      { match: '/api/studio/me', body: me('superadmin') },
      { match: '/notifications', body: { ok: true, unreadCount: 0, nextCursor: null, data: [] } },
      { match: '/businesses', body: { ok: true, local: true, data: [] } },
    ]);
    renderWithSWR(withLocale('en-GB', shell()));
    const nav = screen.getAllByRole('navigation', { name: 'Studio' })[0]!;
    expect(await within(nav).findByText('PostMind staff')).toBeInTheDocument();
  });
});
