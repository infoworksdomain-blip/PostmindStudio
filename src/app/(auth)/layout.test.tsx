// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from './layout';

// QA 1: the sign-in screens have no header, so without a switcher a visitor whose browser language
// is not the one they read could not change it before signing in (the marketing pages have one).

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

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

describe('AuthLayout', () => {
  it('offers the interface language switcher next to the screen', () => {
    render(
      <AuthLayout>
        <p>sign-in form</p>
      </AuthLayout>,
    );
    expect(screen.getByText('sign-in form')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Interface language/ })).toBeInTheDocument();
  });
});
