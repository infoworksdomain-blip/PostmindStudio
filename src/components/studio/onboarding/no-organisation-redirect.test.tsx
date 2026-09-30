// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { NoOrganisationRedirect, isAllowedWithoutOrganisation } from './no-organisation-redirect';

const nav = vi.hoisted(() => ({ pathname: '/projects', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  nav.pathname = '/projects';
  nav.replace.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('NoOrganisationRedirect', () => {
  it('sends a signed-in user with no organisation to /welcome', async () => {
    mockFetch(() => fail(403, 'No organisation yet', 'no_organisation'));
    renderScreen(<NoOrganisationRedirect />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/welcome'));
  });

  it('stays put on /welcome, account settings and the admin area', async () => {
    for (const path of ['/welcome', '/account/security', '/admin']) {
      nav.pathname = path;
      const api = mockFetch(() => fail(403, 'No organisation yet', 'no_organisation'));
      const { unmount } = renderScreen(<NoOrganisationRedirect />);
      await waitFor(() => expect(api.find('GET', '/me').length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 20));
      unmount();
    }
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('does nothing for a member of an organisation or for other errors', async () => {
    const member = mockFetch(() => ok({ me: { identityMode: 'standalone' } }));
    const { unmount } = renderScreen(<NoOrganisationRedirect />);
    await waitFor(() => expect(member.find('GET', '/me').length).toBeGreaterThan(0));
    unmount();
    const denied = mockFetch(() => fail(403, 'Forbidden', 'forbidden'));
    renderScreen(<NoOrganisationRedirect />);
    await waitFor(() => expect(denied.find('GET', '/me').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('matches only the allowed sections, not look-alike paths', () => {
    expect(isAllowedWithoutOrganisation('/welcome')).toBe(true);
    expect(isAllowedWithoutOrganisation('/account/security')).toBe(true);
    expect(isAllowedWithoutOrganisation('/welcomeback')).toBe(false);
    expect(isAllowedWithoutOrganisation('/calendar')).toBe(false);
  });
});
