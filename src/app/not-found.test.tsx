// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STANDALONE_SESSION_COOKIES } from '@/lib/marketing/session-hint';
import NotFound from './not-found';

// 26.2 — the 404 page sits under the site header (the brand logo), so it is not an orphan page: the mark links
// home; signed out the header offers Sign in, signed in it shows only the mark (linking to Home).

let cookieNames: string[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => cookieNames.map((name) => ({ name, value: 'x' })) }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/nope',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  cookieNames = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('NotFound page', () => {
  it('shows the brand header with the wordmark and keeps the 404 copy', async () => {
    render(await NotFound());
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/');
    expect(within(header).getByRole('link', { name: 'PostMind Studio home' })).toContainElement(
      header.querySelector('img[data-brand-logo="light"]'),
    );
    expect(within(header).getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'We couldn’t find that page' }),
    ).toBeInTheDocument();
  });

  it('signed in, the mark links to Home and there is no sign-in or trial button', async () => {
    cookieNames = [STANDALONE_SESSION_COOKIES[0]!];
    render(await NotFound());
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: /home/i })).toHaveAttribute('href', '/home');
    expect(within(header).queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(within(header).queryByRole('link', { name: /free trial/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '/home');
  });
});
