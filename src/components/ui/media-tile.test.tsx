// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aspectOfSize, MediaTile, mediaAspect } from './media-tile';

// BACKLOG 25.10 — the MediaTile primitive: one named link or button, a declared frame, a lazy
// poster, a mono duration badge, decorative play affordance, and a hover preview that waits,
// only when one is supplied and never under reduced motion.

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MediaTile', () => {
  it('is a link named by its title and described by its meta line', () => {
    render(
      <MediaTile
        href="/library/v1"
        title="Morning coffee"
        meta="Cafés · Fast cut"
        posterUrl="https://cdn.test/p.jpg"
        posterWidth={1080}
        posterHeight={1920}
        duration="0:21"
        pill={<span>Inspire only</span>}
      />,
    );
    const link = screen.getByRole('link', { name: 'Morning coffee' });
    expect(link).toHaveAttribute('href', '/library/v1');
    expect(link).toHaveAccessibleDescription('Cafés · Fast cut');
    const img = link.querySelector('img');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('width', '1080');
    expect(link.querySelector('[data-slot="media-frame"]')?.className).toContain('aspect-[9/16]');
    const duration = link.querySelector('[data-slot="media-duration"]');
    expect(duration).toHaveTextContent('0:21');
    expect(duration?.className).toContain('font-mono');
    expect(link.querySelector('[data-slot="media-play"]')).toHaveAttribute('aria-hidden');
  });

  it('is a button when it opens something in place', async () => {
    const onSelect = vi.fn();
    render(
      <MediaTile title="Loaves" kind="image" aspect="4:5" fit="contain" onSelect={onSelect} />,
    );
    const button = screen.getByRole('button', { name: 'Loaves' });
    expect(button.querySelector('[data-slot="media-play"]')).toBeNull();
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('plays the preview after a pause, and not on a fly-over', () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    render(
      <MediaTile title="Clip" href="/x" renderPreview={() => <video data-testid="preview" />} />,
    );
    const link = screen.getByRole('link', { name: 'Clip' });
    fireEvent.mouseEnter(link);
    fireEvent.mouseLeave(link);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId('preview')).toBeNull();
    fireEvent.focus(link);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByTestId('preview')).toBeInTheDocument();
  });

  it('never previews under reduced motion', () => {
    setReducedMotion(true);
    vi.useFakeTimers();
    render(
      <MediaTile title="Clip" href="/x" renderPreview={() => <video data-testid="preview" />} />,
    );
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Clip' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('maps aspect strings and pixel sizes to frames', () => {
    expect(mediaAspect('16:9')).toBe('16:9');
    expect(mediaAspect('3:2')).toBe('9:16');
    expect(aspectOfSize(1920, 1080)).toBe('16:9');
    expect(aspectOfSize(1080, 1350)).toBe('4:5');
    expect(aspectOfSize(500, 500)).toBe('1:1');
    expect(aspectOfSize(null, 10, '1:1')).toBe('1:1');
  });
});
