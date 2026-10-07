// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_CLIPS } from '@/lib/marketing/media';
import { LandingPage } from './landing-page';
import {
  ClipMedia,
  RevealOnScroll,
  VideosToggle,
  setVideosPaused,
  videoAllowed,
} from './landing/motion';

// 25.5 — the landing page's media: real Studio posters (alt, size, <picture> sources, one LCP
// image), no video on phones / reduced motion / Save-Data, play while in view, one pause control
// (WCAG 2.2.2), and the scroll reveal that never hides content by default.

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

type MediaQueries = { wide?: boolean; reduced?: boolean };

function stubMatchMedia({ wide = true, reduced = false }: MediaQueries = {}) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('min-width') ? wide : query.includes('reduce') ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** IntersectionObserver whose callbacks a test can fire. */
const observers: Array<{ cb: IntersectionObserverCallback; els: Element[] }> = [];
class FakeIO {
  constructor(public cb: IntersectionObserverCallback) {
    observers.push({ cb, els: (this.els = []) });
  }
  els: Element[];
  observe(el: Element) {
    this.els.push(el);
  }
  unobserve() {}
  disconnect() {}
}
function intersect(el: Element, isIntersecting: boolean) {
  for (const o of observers.filter((x) => x.els.includes(el))) {
    o.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  setVideosPaused(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LandingPage media', () => {
  it('gives every image alt text, a width and a height, from real Studio output or screens', () => {
    const { container } = render(<LandingPage />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(20);
    for (const img of imgs) {
      expect(img.hasAttribute('alt')).toBe(true);
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
      expect(img.getAttribute('src')).toMatch(
        /^\/marketing\/(studio|screens)\/[\w-]+\.(webp|jpg)$/,
      );
    }
    expect(container.innerHTML).not.toContain('/marketing/photos/');
  });

  it('loads only the hero poster eagerly with high priority (the LCP image); the rest are lazy', () => {
    const { container } = render(<LandingPage />);
    const eager = [...container.querySelectorAll('img')].filter(
      (img) => img.getAttribute('loading') !== 'lazy',
    );
    expect(eager).toHaveLength(1);
    expect(eager[0]).toHaveAttribute('fetchpriority', 'high');
    expect(eager[0]).toHaveAttribute('src', '/marketing/studio/seedance-bread.jpg');
    expect(eager[0]).toHaveAttribute('width', '720');
    expect(eager[0]).toHaveAttribute('height', '1280');
    const source = eager[0]!.parentElement!.querySelector('source')!;
    expect(source).toHaveAttribute('type', 'image/webp');
    expect(source.getAttribute('srcset')).toBe(
      '/marketing/studio/seedance-bread-360.webp 360w, /marketing/studio/seedance-bread-720.webp 720w',
    );
    expect(
      screen.getByRole('img', {
        name: /golden sourdough loaf on a wooden board, steam rising, the camera/,
      }),
    ).toBe(eager[0]);
  });

  it('labels the showcase strip with each business type and format', () => {
    render(<LandingPage />);
    const strip = screen.getByRole('region', { name: 'Example posts made with Studio' });
    expect(strip).toHaveAttribute('tabindex', '0');
    expect(strip).toHaveTextContent('Northside BakerySourdough bakery · , AI video');
    expect(strip).toHaveTextContent('Pulse StudioFitness studio · , Wall of text');
    expect(strip).toHaveTextContent('Atelier WrenLinen boutique · , Slideshow');
    expect(strip.querySelectorAll('li')).toHaveLength(9);
  });

  it('renders no video on the server or on phones, and no pause control', () => {
    stubMatchMedia({ wide: false });
    const { container } = render(<LandingPage />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause videos' })).toBeNull();
  });

  it('renders no video with reduced motion or Save-Data', () => {
    stubMatchMedia({ reduced: true });
    expect(videoAllowed()).toBe(false);
    stubMatchMedia();
    vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
    expect(videoAllowed()).toBe(false);
  });
});

describe('ClipMedia', () => {
  it('mounts a muted, preload=none loop on wide screens and plays it only while in view', () => {
    stubMatchMedia();
    const { container } = render(
      <ClipMedia clip={STUDIO_CLIPS.atelierWren} alt="Linen" sizes="20rem" />,
    );
    const video = container.querySelector('video')!;
    expect(video).toHaveAttribute('preload', 'none');
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('aria-hidden', 'true');
    expect(video.querySelector('source')).toHaveAttribute(
      'src',
      '/marketing/studio/atelier-wren-slideshow.mp4',
    );
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() => intersect(container.firstElementChild!, true));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    act(() => intersect(container.firstElementChild!, false));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('in hover mode plays only while the pointer is over it', () => {
    stubMatchMedia();
    const { container } = render(
      <ClipMedia clip={STUDIO_CLIPS.pulseStudio} alt="Gym" sizes="16rem" play="hover" />,
    );
    const root = container.firstElementChild!;
    act(() => intersect(root, true));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.pointerEnter(root);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(root);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('stops every clip when the visitor presses Pause videos, and resumes on Play videos', () => {
    stubMatchMedia();
    const { container } = render(
      <>
        <ClipMedia clip={STUDIO_CLIPS.seedanceBread} alt="Bread" sizes="20rem" />
        <VideosToggle />
      </>,
    );
    act(() => intersect(container.firstElementChild!, true));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause videos' }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    const play = screen.getByRole('button', { name: 'Play videos' });
    expect(play).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(play);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  });
});

describe('RevealOnScroll', () => {
  /** Lay out: the element with data-testid "below" sits at `belowTop`, everything else at 10. */
  function layout(belowTop: () => number) {
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { top: this.dataset.testid === 'below' ? belowTop() : 10 } as DOMRect;
    });
  }
  const page = () => (
    <RevealOnScroll>
      <div data-reveal data-testid="above" />
      <div data-reveal data-testid="below" />
    </RevealOnScroll>
  );

  it('hides nothing when nothing is below the fold', () => {
    stubMatchMedia();
    render(page());
    // jsdom lays nothing out (every top is 0), so everything stays visible.
    expect(screen.getByTestId('above').dataset.reveal).not.toBe('waiting');
    expect(screen.getByTestId('below').dataset.reveal).not.toBe('waiting');
  });

  it('marks below-the-fold content waiting, then shows it once scrolled into (or past) view', () => {
    stubMatchMedia();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0; // ran synchronously: nothing left pending
    });
    let top = 5000;
    layout(() => top);
    render(page());
    const below = screen.getByTestId('below');
    expect(screen.getByTestId('above').dataset.reveal).not.toBe('waiting');
    expect(below.dataset.reveal).toBe('waiting');
    top = 3000;
    fireEvent.scroll(window);
    expect(below.dataset.reveal).toBe('waiting');
    top = -2000; // a jump straight past it (End key, anchor) still reveals it
    fireEvent.scroll(window);
    expect(below.dataset.reveal).toBe('shown');
  });

  it('does nothing with reduced motion', () => {
    stubMatchMedia({ reduced: true });
    layout(() => 5000);
    render(page());
    expect(screen.getByTestId('below').dataset.reveal).not.toBe('waiting');
  });
});
