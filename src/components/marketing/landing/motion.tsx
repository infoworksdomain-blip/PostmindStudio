'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { marketingSrc } from '@/lib/marketing/media-src';
import { STUDIO_CLIPS, type StudioClip } from '@/lib/marketing/media';
import { cn } from '@/lib/utils';

// 25.5 — the landing page's only client code: Studio-made clips that play muted while in view,
// one "Pause videos" control for the page (WCAG 2.2.2: the loops run longer than 5 s), and the
// scroll-entry reveal.
//
// Performance rules: the server renders the poster as a <picture> (WebP 360/720 + JPEG fallback,
// explicit size); a <video preload="none"> is only mounted on screens ≥ 768 px wide, without
// prefers-reduced-motion and without Save-Data, and only plays while it is on screen. Phones get
// the poster and never download video. Without JavaScript everything is visible and still.

const WIDE = '(min-width: 768px)';
const REDUCED = '(prefers-reduced-motion: reduce)';
const PAUSED_KEY = 'pm.marketing.videosPaused';

type NetworkInformation = { saveData?: boolean };

/** False in the single-file demo, whose media shim serves posters only (no video URLs). */
const VIDEO_SERVED = marketingSrc(STUDIO_CLIPS.seedanceBread.video.path) !== '';

/** True when this visitor may get moving video (wide screen, motion allowed, no Save-Data). */
export function videoAllowed(win: Window = window): boolean {
  if (!VIDEO_SERVED || typeof win.matchMedia !== 'function') return false;
  const connection = (win.navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (connection?.saveData) return false;
  return win.matchMedia(WIDE).matches && !win.matchMedia(REDUCED).matches;
}

// One paused flag for every clip on the page, remembered for the visitor (best effort).
const listeners = new Set<() => void>();
let paused = readPaused();

function readPaused(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PAUSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setVideosPaused(next: boolean): void {
  paused = next;
  try {
    localStorage.setItem(PAUSED_KEY, next ? '1' : '0');
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useVideosPaused(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => paused,
    () => false,
  );
}

/** Whether moving video is allowed here; false on the server and before mount. */
function useVideoAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(videoAllowed());
  }, []);
  return allowed;
}

export interface ClipPosterProps {
  clip: StudioClip;
  alt: string;
  /** The <img sizes> hint, e.g. "(min-width: 1024px) 22rem, 45vw". */
  sizes: string;
  /** The hero's first poster: the LCP element (eager, fetchpriority high). */
  priority?: boolean;
  /** Above the fold but not the LCP (the hero's side phones): eager, default priority. */
  eager?: boolean;
  className?: string;
}

/** The poster frame: WebP at two widths, JPEG fallback, explicit 9:16 size. */
export function ClipPoster({
  clip,
  alt,
  sizes,
  priority = false,
  eager = false,
  className,
}: ClipPosterProps) {
  const { small, large, fallback } = clip.poster;
  return (
    <picture>
      <source
        type="image/webp"
        srcSet={`${marketingSrc(small.path)} ${small.width}w, ${marketingSrc(large.path)} ${large.width}w`}
        sizes={sizes}
      />
      <img
        src={marketingSrc(fallback.path)}
        width={large.width}
        height={large.height}
        alt={alt}
        loading={priority || eager ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : undefined}
        decoding={priority ? 'sync' : 'async'}
        className={cn('block size-full object-cover', className)}
      />
    </picture>
  );
}

export interface ClipMediaProps extends ClipPosterProps {
  /** 'view': plays while on screen. 'hover': plays while the pointer is over it. */
  play?: 'view' | 'hover';
}

/** A 9:16 clip: the poster, with the muted loop over it once it may and should play. */
export function ClipMedia({ play = 'view', ...poster }: ClipMediaProps) {
  const allowed = useVideoAllowed();
  const pausedByVisitor = useVideosPaused();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!allowed || play !== 'view' || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setActive(Boolean(e?.isIntersecting)), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [allowed, play]);

  const shouldPlay = allowed && active && !pausedByVisitor;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldPlay) {
      // play() rejects when the browser blocks it; the poster simply stays.
      video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  }, [shouldPlay]);

  const hover =
    play === 'hover' && allowed
      ? { onPointerEnter: () => setActive(true), onPointerLeave: () => setActive(false) }
      : {};

  return (
    <div ref={rootRef} className="relative size-full" {...hover}>
      <ClipPoster {...poster} />
      {allowed && (
        <video
          ref={videoRef}
          aria-hidden
          tabIndex={-1}
          muted
          loop
          playsInline
          preload="none"
          width={poster.clip.video.width}
          height={poster.clip.video.height}
          onPlaying={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-300',
            playing ? 'opacity-100' : 'opacity-0',
          )}
        >
          <source src={marketingSrc(poster.clip.video.path)} type={poster.clip.video.type} />
        </video>
      )}
    </div>
  );
}

/** "Pause videos" / "Play videos": shown only where clips can move. */
export function VideosToggle({ className }: { className?: string }) {
  const t = useTranslations('marketing.motion');
  const allowed = useVideoAllowed();
  const isPaused = useVideosPaused();
  if (!allowed) return null;
  return (
    <button
      type="button"
      aria-pressed={isPaused}
      onClick={() => setVideosPaused(!isPaused)}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/80 px-3 text-xs font-medium backdrop-blur transition-colors duration-200 hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
    >
      {isPaused ? (
        <Play aria-hidden className="size-3.5" />
      ) : (
        <Pause aria-hidden className="size-3.5" />
      )}
      {isPaused ? t('play') : t('pause')}
    </button>
  );
}

/**
 * Scroll-entry reveal for elements marked `data-reveal`: content below the fold fades and rises
 * in (≤ 300 ms) as it comes into view. Resting state is visible — nothing is hidden on the server,
 * without JavaScript or with reduced motion. One passive scroll listener (rAF-throttled) checks the
 * waiting elements, so a jump (End key, an anchor, find in page) reveals everything it passed too;
 * it removes itself once everything is shown.
 */
export function RevealOnScroll({ children }: { children?: ReactNode }) {
  useEffect(() => {
    if (window.matchMedia?.(REDUCED).matches) return;
    let waiting = [...document.querySelectorAll<HTMLElement>('[data-reveal]')].filter(
      (el) => el.getBoundingClientRect().top > window.innerHeight,
    );
    for (const el of waiting) el.dataset.reveal = 'waiting';
    let frame = 0;
    const check = () => {
      frame = 0;
      const line = window.innerHeight * 0.92;
      waiting = waiting.filter((el) => {
        if (el.getBoundingClientRect().top >= line) return true;
        el.dataset.reveal = 'shown';
        return false;
      });
      if (waiting.length === 0) window.removeEventListener('scroll', onScroll);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      for (const el of waiting) el.dataset.reveal = '';
    };
  }, []);
  return <>{children}</>;
}
