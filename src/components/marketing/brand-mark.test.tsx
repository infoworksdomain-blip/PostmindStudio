// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import Link from 'next/link';
import { describe, expect, it } from 'vitest';
import { BrandIcon, BrandLogo } from './brand-mark';

// 26.2 — the brand artwork: one accessible name per logo, both theme variants in the markup (CSS
// shows one), fixed dimensions (no layout shift), webp with a PNG fallback.

describe('BrandLogo', () => {
  it('is one image named "PostMind Studio" holding the light and dark lockups', () => {
    const { container } = render(<BrandLogo />);
    const logo = screen.getByRole('img', { name: 'PostMind Studio' });
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(logo).toContainElement(img);
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('width', '120');
      expect(img).toHaveAttribute('height', '40');
    }
    const light = container.querySelector('img[data-brand-logo="light"]')!;
    const dark = container.querySelector('img[data-brand-logo="dark"]')!;
    expect(light).toHaveAttribute('src', '/brand/logo-light.png');
    expect(dark).toHaveAttribute('src', '/brand/logo-dark.png');
    expect(light.parentElement).toHaveClass('dark:hidden');
    expect(dark.parentElement).toHaveClass('hidden', 'dark:block');
    expect(light.parentElement?.querySelector('source')).toHaveAttribute(
      'srcset',
      '/brand/logo-light.webp',
    );
  });

  it('loads lazily unless it is a header logo', () => {
    const { container, rerender } = render(<BrandLogo />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'lazy');
    rerender(<BrandLogo eager />);
    expect(container.querySelector('img')).toHaveAttribute('loading', 'eager');
  });

  it('adds no name of its own inside a link that is already named', () => {
    render(
      <Link href="/" aria-label="PostMind Studio home">
        <BrandLogo label={null} />
      </Link>,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'PostMind Studio home' })).toBeInTheDocument();
  });
});

describe('BrandIcon', () => {
  it('is the icon alone with the brand name as alt text', () => {
    render(<BrandIcon />);
    const icon = screen.getByRole('img', { name: 'PostMind Studio' });
    expect(icon).toHaveAttribute('src', '/brand/icon-64.png');
    expect(icon).toHaveAttribute('width', '28');
  });
});
