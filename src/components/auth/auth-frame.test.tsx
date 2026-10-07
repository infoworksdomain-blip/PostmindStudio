// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthFrame } from './auth-frame';

// 25.6 — the signed-out frame: wordmark, the form in <main>, the language switcher, and a brand
// panel (hidden below lg by CSS) showing a real product screen in both themes.

vi.mock('next/navigation', () => ({
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

describe('AuthFrame', () => {
  it('frames the form with the wordmark, the switcher and the brand panel', () => {
    render(
      <AuthFrame>
        <p>form</p>
      </AuthFrame>,
    );
    expect(within(screen.getByRole('main')).getByText('form')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PostMind Studio' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('combobox', { name: /Interface language/ })).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'About PostMind Studio' });
    expect(panel.className).toContain('hidden');
    expect(panel.className).toContain('lg:flex');
    const images = within(panel).getAllByRole('img');
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      '/marketing/screens/review-light.webp',
      '/marketing/screens/review-dark.webp',
    ]);
    for (const img of images) {
      expect(img).toHaveAttribute('width', '1200');
      expect(img).toHaveAttribute('height', '750');
      expect(img).toHaveAttribute('loading', 'lazy');
    }
  });
});
