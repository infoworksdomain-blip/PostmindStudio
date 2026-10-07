// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../../test/i18n-wrapper';
import { mockFetch, renderWithSWR } from '../library/test-helpers';
import { Sidebar, SIDEBAR_STORAGE_KEY, useSidebarCollapsed } from './sidebar';

// BACKLOG 25.4 — the sidebar: groups, the primary Create button (Get started while onboarding is
// unfinished), the active row, and the icon rail remembered per browser.

vi.mock('next/navigation', () => ({ usePathname: () => '/plans/pl_1' }));

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const onboarding = (suggested: boolean) => ({
  onboarding: {
    step: 'connect',
    completed: [],
    firstVideoProjectId: null,
    dismissedAt: null,
    startedAt: null,
    suggested,
  },
});

function Harness() {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  return <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />;
}

describe('Sidebar', () => {
  it('groups the destinations and marks the current section', async () => {
    mockFetch([{ match: '/onboarding', body: onboarding(false) }]);
    renderWithSWR(withLocale('en-GB', <Harness />));
    const nav = screen.getByRole('navigation', { name: 'Studio' });
    for (const label of ['Create', 'Plan', 'Library', 'Insights', 'Settings'])
      expect(within(nav).getByText(label, { selector: 'p' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Month plans' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
    // Export data moved to the account menu.
    expect(within(nav).queryByRole('link', { name: 'Export data' })).toBeNull();
    expect(await within(nav).findByRole('link', { name: 'Create a new post' })).toHaveAttribute(
      'href',
      '/new',
    );
  });

  it('shows Get started instead of Create while onboarding is unfinished', async () => {
    mockFetch([{ match: '/onboarding', body: onboarding(true) }]);
    renderWithSWR(withLocale('en-GB', <Harness />));
    expect(await screen.findByRole('link', { name: 'Get started' })).toHaveAttribute(
      'href',
      '/welcome',
    );
    expect(screen.queryByRole('link', { name: 'Create a new post' })).toBeNull();
  });

  it('folds into an icon rail and remembers it', async () => {
    mockFetch([{ match: '/onboarding', body: onboarding(false) }]);
    const user = userEvent.setup();
    const { unmount } = renderWithSWR(withLocale('en-GB', <Harness />));
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('1');
    // Names stay for screen readers in the rail.
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeInTheDocument();
    unmount();

    renderWithSWR(withLocale('en-GB', <Harness />));
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('still works when storage is blocked', async () => {
    mockFetch([{ match: '/onboarding', body: onboarding(false) }]);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    renderWithSWR(withLocale('en-GB', <Harness />));
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument(),
    );
    getItem.mockRestore();
    setItem.mockRestore();
  });
});
