// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../../library/test-helpers';
import { ProfileScreen } from '../profile-screen';
import { SecurityScreen } from './security-screen';
import { deviceLabel } from './sessions-section';

// Phase 18 Track A — /account/security and /account/profile.

const session = {
  session: { id: 's1', token: 't', activeOrganizationId: 'org', createdAt: '2026-09-29T10:00:00Z' },
  user: {
    id: 'u1',
    email: 'ada@example.com',
    name: 'Ada',
    emailVerified: true,
    twoFactorEnabled: false,
    locale: 'fr',
  },
};

const chromeMac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function routes() {
  return mockFetch([
    { match: '/api/auth/get-session', body: session },
    { match: '/api/auth/list-accounts', body: [{ providerId: 'credential' }] },
    {
      match: '/api/studio/account/sessions',
      body: {
        ok: true,
        sessions: [
          {
            id: 's1',
            createdAt: '',
            lastActiveAt: '2026-09-29T10:00:00Z',
            ipAddress: null,
            userAgent: chromeMac,
            current: true,
          },
          {
            id: 's2',
            createdAt: '',
            lastActiveAt: '2026-09-28T10:00:00Z',
            ipAddress: '203.0.113.9',
            userAgent: null,
            current: false,
          },
        ],
      },
    },
    {
      match: '/api/studio/account/sessions/s2',
      method: 'DELETE',
      body: { ok: true, revoked: true },
    },
    {
      match: '/api/auth/two-factor/enable',
      method: 'POST',
      body: {
        totpURI: 'otpauth://totp/Studio:ada?secret=JBSWY3DPEHPK3PXP&issuer=Studio',
        backupCodes: ['aaaaa-11111', 'bbbbb-22222'],
      },
    },
    {
      match: '/api/studio/account/delete',
      method: 'POST',
      status: 409,
      body: {
        ok: false,
        error: 'conflict',
        message: 'x',
        details: { reason: 'sole_owner', organisations: [{ organisationId: 'o', name: 'Acme' }] },
      },
    },
  ]);
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('SecurityScreen', () => {
  it('lists sessions without tokens and revokes another device', async () => {
    const fetchMock = routes();
    renderWithSWR(<SecurityScreen googleEnabled={false} />);
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out Unknown device' }));
    await waitFor(() =>
      expect(
        fetchMock.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/sessions/s2')),
      ).toBe(true),
    );
  });

  it('starts TOTP enrolment with the password and shows the QR and manual key', async () => {
    routes();
    renderWithSWR(<SecurityScreen googleEnabled={false} />);
    const section = (await screen.findByRole('heading', { name: 'Two-step verification' })).closest(
      'section',
    )!;
    const pw = section.querySelector('input[type="password"]') as HTMLInputElement;
    await userEvent.type(pw, 'my password here');
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('explains when deletion is blocked by sole ownership', async () => {
    routes();
    renderWithSWR(<SecurityScreen googleEnabled={false} />);
    // 25.12: the danger zone's button opens the confirmation, which asks for the password and
    // the "I understand" tick and stays open to explain a refusal.
    await screen.findByRole('heading', { name: 'Delete account' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete account' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete my account' });
    expect(confirm).toBeDisabled();
    await userEvent.type(dialog.querySelector('input[type="password"]') as HTMLInputElement, 'pw');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(confirm);
    expect(await within(dialog).findByText(/only owner of Acme/)).toBeInTheDocument();
  });

  it('renders in Arabic (RTL) and Simplified Chinese', async () => {
    routes();
    const { unmount } = renderWithSWR(withLocale('ar', <SecurityScreen googleEnabled />));
    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول والأمان' }),
    ).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    unmount();
    routes();
    renderWithSWR(withLocale('zh-Hans', <SecurityScreen googleEnabled />));
    expect(await screen.findByRole('heading', { name: '登录与安全' })).toBeInTheDocument();
  });
});

describe('ProfileScreen', () => {
  it('loads name and email language, and renders in ar and zh-Hans', async () => {
    routes();
    const { unmount } = renderWithSWR(<ProfileScreen />);
    expect(await screen.findByDisplayValue('Ada')).toBeInTheDocument();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('fr');
    unmount();
    routes();
    const ar = renderWithSWR(withLocale('ar', <ProfileScreen />));
    expect(await screen.findByRole('heading', { name: 'الملف الشخصي' })).toBeInTheDocument();
    ar.unmount();
    routes();
    renderWithSWR(withLocale('zh-Hans', <ProfileScreen />));
    expect(await screen.findByRole('heading', { name: '个人资料' })).toBeInTheDocument();
  });
});

describe('deviceLabel', () => {
  it('names common browsers and systems, or nothing', () => {
    expect(deviceLabel(chromeMac)).toEqual({ browser: 'Chrome', os: 'macOS' });
    expect(deviceLabel('curl/8')).toBeNull();
    expect(deviceLabel(null)).toBeNull();
  });
});
