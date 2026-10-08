// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthFrame } from './auth-frame';

// 25.6 — the signed-out frame: wordmark, the form in <main>, the language switcher, and a brand
// panel (hidden below lg by CSS) showing two posts made with Studio (25.5 showcase media).

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
    // Two posts made with Studio, described as one picture; the posters themselves are decorative.
    const picture = within(panel).getByRole('img', { name: /made with PostMind Studio/ });
    const posters = picture.querySelectorAll('img');
    expect([...posters].map((img) => img.getAttribute('src'))).toEqual([
      '/marketing/studio/seedance-bread.jpg',
      '/marketing/studio/coastline-stays-slideshow.jpg',
    ]);
    for (const img of posters) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('width', '540');
      expect(img).toHaveAttribute('height', '960');
    }
  });
});
