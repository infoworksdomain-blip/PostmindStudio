'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FLOW_SCREENS, FLOW_STEPS, imgProps } from '@/lib/marketing/media';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';

// Phase 20.8 — the landing page's product flow as a tabbed carousel (WAI-ARIA APG "carousel with
// tabs"): Brief → Script → Generate → Review → Calendar → Analytics, each slide a real screen from
// the demo build (light and dark theme) with a line of copy.
//
// Accessibility: the step tabs are a tablist (roving tabindex; Left/Right follow the reading
// direction, Home/End), Previous/Next buttons, and each slide is a labelled group ("2 of 6").
// It advances on its own only when the visitor has not asked for reduced motion, and it stops
// while the pointer is over it, while anything inside has focus, while it is off screen, and for
// good once the visitor pauses it or picks a slide. The live region is polite only while it is
// not rotating, so a moving slideshow does not talk over the page.

export const ADVANCE_MS = 7000;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isRtl(el: HTMLElement | null): boolean {
  if (!el) return false;
  const dir = el.closest('[dir]')?.getAttribute('dir') ?? document.documentElement.dir;
  return dir === 'rtl';
}

export function FlowCarousel() {
  const t = useTranslations('marketing.flow');
  const baseId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [index, setIndex] = useState(0);
  // null until mounted: the server render (and a no-JS visitor) never rotates.
  const [playing, setPlaying] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(true);
  const total = FLOW_STEPS.length;

  useEffect(() => {
    setPlaying(!prefersReducedMotion());
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      threshold: 0.25,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const rotating = playing === true && !hovered && !focused && visible;

  useEffect(() => {
    if (!rotating) return;
    const timer = window.setTimeout(() => setIndex((i) => (i + 1) % total), ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, index, total]);

  /** A visitor's choice: show that slide and stop rotating. */
  const choose = useCallback(
    (next: number, focusTab = false) => {
      const i = (next + total) % total;
      setIndex(i);
      setPlaying(false);
      if (focusTab) tabRefs.current[i]?.focus();
    },
    [total],
  );

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const forward = isRtl(e.currentTarget) ? 'ArrowLeft' : 'ArrowRight';
    const back = isRtl(e.currentTarget) ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (e.key === forward) next = index + 1;
    else if (e.key === back) next = index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = total - 1;
    if (next === null) return;
    e.preventDefault();
    choose(next, true);
  }

  return (
    <section
      ref={rootRef}
      aria-roledescription={t('roleCarousel')}
      aria-labelledby={`${baseId}-title`}
      className="py-20"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">{t('eyebrow')}</p>
          <h2
            id={`${baseId}-title`}
            className="mt-3 font-display text-5xl leading-none md:text-6xl"
          >
            {t('title')}
          </h2>
          <p className="mt-4 max-w-xl text-muted-foreground">{t('body')}</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            type="button"
            variant="outline"
            size="icon-lg"
            tooltip={false}
            label={playing ? t('pause') : t('play')}
            onClick={() => setPlaying((p) => !p)}
            className="rounded-full bg-background"
          >
            {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
          </IconButton>
          <IconButton
            type="button"
            variant="outline"
            size="icon-lg"
            tooltip={false}
            label={t('previous')}
            aria-controls={`${baseId}-slides`}
            onClick={() => choose(index - 1)}
            className="rounded-full bg-background"
          >
            <ChevronLeft aria-hidden className="rtl:-scale-x-100" />
          </IconButton>
          <IconButton
            type="button"
            variant="primary"
            size="icon-lg"
            tooltip={false}
            label={t('next')}
            aria-controls={`${baseId}-slides`}
            onClick={() => choose(index + 1)}
            className="rounded-full"
          >
            <ChevronRight aria-hidden className="rtl:-scale-x-100" />
          </IconButton>
        </div>
      </div>

      {/* The step picker reads as an edit timeline: numbered clips on one track. */}
      <div
        role="tablist"
        aria-label={t('stepsLabel')}
        className="mt-10 grid grid-cols-3 gap-1.5 sm:grid-cols-6"
      >
        {FLOW_STEPS.map((s, i) => {
          const selected = i === index;
          return (
            <button
              key={s}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${s}`}
              aria-selected={selected}
              aria-controls={`${baseId}-slide-${s}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(i)}
              onKeyDown={onTabKeyDown}
              className={cn(
                'group relative overflow-hidden rounded-md border px-2.5 pt-2 pb-2.5 text-start transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                selected
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background hover:border-foreground/40',
              )}
            >
              <span className="block font-mono text-[0.65rem] opacity-70" dir="ltr">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="mt-0.5 block truncate text-sm font-medium">{t(`${s}.tab`)}</span>
              {selected && rotating && (
                <span
                  aria-hidden
                  key={`progress-${index}`}
                  className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-progress bg-primary rtl:origin-right"
                />
              )}
            </button>
          );
        })}
      </div>

      <div
        id={`${baseId}-slides`}
        aria-live={rotating ? 'off' : 'polite'}
        className="relative mt-6"
      >
        {FLOW_STEPS.map((s, i) => {
          const shot = FLOW_SCREENS[s];
          const active = i === index;
          return (
            <div
              key={s}
              id={`${baseId}-slide-${s}`}
              role="tabpanel"
              aria-roledescription={t('roleSlide')}
              aria-label={t('slideLabel', { current: i + 1, total })}
              hidden={!active}
              className="grid items-center gap-8 motion-safe:animate-slide-in lg:grid-cols-[1fr_2.2fr] lg:gap-12"
            >
              <div className="order-2 lg:order-1">
                <p className="font-mono text-xs text-primary" dir="ltr">
                  {String(i + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
                </p>
                <h3 className="mt-3 font-display text-4xl leading-none md:text-5xl">
                  {t(`${s}.title`)}
                </h3>
                <p className="mt-4 text-muted-foreground">{t(`${s}.body`)}</p>
              </div>
              <figure className="order-1 overflow-hidden rounded-xl border border-border bg-muted shadow-[0_40px_80px_-40px_rgb(20_24_31/0.4)] ring-1 ring-border lg:order-2">
                {/* Window chrome, so the screenshot reads as the product in a browser. */}
                <div
                  aria-hidden
                  className="flex items-center gap-1.5 border-b border-border px-3 py-2"
                >
                  <span className="size-2 rounded-full bg-primary/70" />
                  <span className="size-2 rounded-full bg-foreground/20" />
                  <span className="size-2 rounded-full bg-foreground/20" />
                </div>
                {/* Only the displayed theme's image is fetched: hidden lazy images never load. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  {...imgProps(shot.light)}
                  alt={t(`${s}.alt`)}
                  loading="lazy"
                  decoding="async"
                  className="block h-auto w-full dark:hidden"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  {...imgProps(shot.dark)}
                  alt={t(`${s}.alt`)}
                  loading="lazy"
                  decoding="async"
                  className="hidden h-auto w-full dark:block"
                />
              </figure>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t('note')}</p>
    </section>
  );
}
