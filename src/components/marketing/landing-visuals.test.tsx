// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLocale } from '../../../test/i18n-wrapper';
import { ADVANCE_MS, FlowCarousel } from './flow-carousel';
import { LandingPage } from './landing-page';

// BACKLOG 20.8 — the landing page's images (alt, size, loading priority) and the product-flow
// carousel (tabs, keyboard, Previous/Next, auto-advance that stops on hover, focus, pause and
// reduced motion; right to left in Arabic).

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LandingPage images', () => {
  it('gives every image alt text (empty when decorative), a width and a height', () => {
    const { container } = render(<LandingPage />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(10);
    for (const img of imgs) {
      expect(img.hasAttribute('alt')).toBe(true);
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
      expect(img.getAttribute('src')).toMatch(/^\/marketing\/(studio|screens)\/[\w-]+\.webp$/);
    }
  });

  it('loads only the hero phone eagerly with high priority; everything else is lazy', () => {
    const { container } = render(<LandingPage />);
    const eager = [...container.querySelectorAll('img')].filter(
      (img) => img.getAttribute('loading') !== 'lazy',
    );
    expect(eager).toHaveLength(1);
    expect(eager[0]).toHaveAttribute('fetchpriority', 'high');
    expect(eager[0]).toHaveAttribute('src', '/marketing/studio/seedance-bread-720.webp');
    expect(screen.getByRole('img', { name: /steam rising from a freshly baked loaf/ })).toBe(
      eager[0],
    );
  });

  it('shows real Studio output in the contact sheet and says the businesses are examples', () => {
    render(<LandingPage />);
    expect(screen.getByRole('img', { name: /washed linen in rust and sage green/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /resistance bands/ })).toBeTruthy();
    expect(screen.getByText('Single-origin espresso')).toBeVisible();
    expect(
      screen.getByText('Made with PostMind Studio. The businesses shown are examples.'),
    ).toBeVisible();
    expect(screen.queryByText(/Stock photos/)).toBeNull();
  });
});

describe('FlowCarousel', () => {
  const tabs = () => screen.getAllByRole('tab');
  const selected = () => tabs().find((t) => t.getAttribute('aria-selected') === 'true');
  const visiblePanels = () =>
    screen.getAllByRole('tabpanel', { hidden: true }).filter((p) => !p.hidden);
  const region = () => screen.getByRole('region', { name: 'Watch a video get made.' });

  it('is a labelled carousel with six step tabs, one visible slide and its screen', () => {
    render(<FlowCarousel />);
    expect(region()).toHaveAttribute('aria-roledescription', 'carousel');
    expect(screen.getByRole('tablist', { name: 'Steps' })).toBeTruthy();
    expect(tabs().map((t) => t.textContent)).toEqual([
      '01Brief',
      '02Script',
      '03Generate',
      '04Review',
      '05Calendar',
      '06Analytics',
    ]);
    expect(selected()).toHaveTextContent('Brief');
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(visiblePanels()).toHaveLength(1);
    const panel = visiblePanels()[0]!;
    expect(panel).toHaveAttribute('aria-roledescription', 'slide');
    expect(panel).toHaveAttribute('aria-label', '1 of 6');
    expect(selected()).toHaveAttribute('aria-controls', panel.id);
    const shots = within(panel).getAllByRole('img', { hidden: true });
    expect(shots.map((i) => i.getAttribute('src'))).toEqual([
      '/marketing/screens/brief-light.webp',
      '/marketing/screens/brief-dark.webp',
    ]);
    expect(shots[0]).toHaveAccessibleName(/Create screen with a brief/);
    for (const img of shots) expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('moves with the arrow keys, Home and End, and keeps focus on the selected tab', () => {
    render(<FlowCarousel />);
    tabs()[0]!.focus();
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Script');
    expect(document.activeElement).toBe(selected());
    expect(visiblePanels()[0]).toHaveAttribute('aria-label', '2 of 6');
    fireEvent.keyDown(selected()!, { key: 'End' });
    expect(selected()).toHaveTextContent('Analytics');
    fireEvent.keyDown(selected()!, { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('Brief');
    fireEvent.keyDown(selected()!, { key: 'ArrowLeft' });
    expect(selected()).toHaveTextContent('Analytics');
    fireEvent.keyDown(selected()!, { key: 'Home' });
    expect(selected()).toHaveTextContent('Brief');
  });

  it('has Previous and Next buttons that wrap round', () => {
    render(<FlowCarousel />);
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(selected()).toHaveTextContent('Script');
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(selected()).toHaveTextContent('Analytics');
  });

  it('advances on its own, waits on hover and focus, and stops for good when paused', () => {
    vi.useFakeTimers();
    render(<FlowCarousel />);
    const live = () => visiblePanels()[0]!.parentElement!;
    act(() => vi.advanceTimersByTime(ADVANCE_MS));
    expect(selected()).toHaveTextContent('Script');
    expect(live()).toHaveAttribute('aria-live', 'off');

    fireEvent.mouseEnter(region());
    act(() => vi.advanceTimersByTime(ADVANCE_MS * 2));
    expect(selected()).toHaveTextContent('Script');
    fireEvent.mouseLeave(region());
    act(() => vi.advanceTimersByTime(ADVANCE_MS));
    expect(selected()).toHaveTextContent('Generate');

    fireEvent.focus(tabs()[2]!);
    act(() => vi.advanceTimersByTime(ADVANCE_MS * 2));
    expect(selected()).toHaveTextContent('Generate');
    fireEvent.blur(tabs()[2]!, { relatedTarget: document.body });

    fireEvent.click(screen.getByRole('button', { name: 'Pause the slideshow' }));
    act(() => vi.advanceTimersByTime(ADVANCE_MS * 3));
    expect(selected()).toHaveTextContent('Generate');
    expect(live()).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Play the slideshow' })).toBeTruthy();
  });

  it('stops rotating once the visitor picks a step', () => {
    vi.useFakeTimers();
    render(<FlowCarousel />);
    fireEvent.click(tabs()[3]!);
    act(() => vi.advanceTimersByTime(ADVANCE_MS * 3));
    expect(selected()).toHaveTextContent('Review');
  });

  it('never advances on its own when the visitor prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.useFakeTimers();
    render(<FlowCarousel />);
    act(() => vi.advanceTimersByTime(ADVANCE_MS * 3));
    expect(selected()).toHaveTextContent('Brief');
    expect(screen.getByRole('button', { name: 'Play the slideshow' })).toBeTruthy();
  });

  it('follows the reading direction in Arabic: ArrowLeft goes forward', () => {
    render(withLocale('ar', <FlowCarousel />));
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' });
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tablist').textContent).toMatch(/[؀-ۿ]/);
  });
});
