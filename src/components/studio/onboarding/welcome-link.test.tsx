// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { WelcomeLink } from './welcome-link';

vi.mock('next/navigation', () => ({ usePathname: () => '/projects' }));
afterEach(() => vi.unstubAllGlobals());

const state = (suggested: boolean) => ({
  onboarding: {
    step: 'connect',
    completed: [],
    firstVideoProjectId: null,
    dismissedAt: null,
    startedAt: null,
    suggested,
  },
});

describe('WelcomeLink', () => {
  it('links to /welcome while setup is suggested', async () => {
    mockFetch(() => ok(state(true)));
    renderScreen(<WelcomeLink />);
    expect(await screen.findByRole('link', { name: 'Get started' })).toHaveAttribute(
      'href',
      '/welcome',
    );
  });

  it('stays hidden when setup is not suggested or cannot load', async () => {
    const api = mockFetch(() => ok(state(false)));
    const { unmount } = renderScreen(<WelcomeLink />);
    await waitFor(() => expect(api.find('GET', '/onboarding')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: 'Get started' })).toBeNull();
    unmount();

    const failing = mockFetch(() => fail(500, 'down'));
    renderScreen(<WelcomeLink />);
    await waitFor(() => expect(failing.find('GET', '/onboarding').length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: 'Get started' })).toBeNull();
  });
});
