import type { ReactNode } from 'react';
import { PRODUCT_SCREENS, imgProps, type ProductScreen } from '@/lib/marketing/media';
import { cn } from '@/lib/utils';

// 25.5 — building blocks shared by the landing sections: the page container, the section rhythm,
// the eyebrow with the record dot, headings, and the themed product screen.

/** Page width and gutters (the marketing shell no longer constrains <main>). */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 md:px-8', className)}>{children}</div>;
}

/**
 * A landing section with the page rhythm. `tone="darkroom"` forces the dark tokens for the band
 * (media reads best on dark), in both themes.
 */
export function Band({
  id,
  labelledBy,
  tone = 'daylight',
  className,
  children,
}: {
  id?: string;
  labelledBy: string;
  tone?: 'daylight' | 'darkroom';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        'py-[clamp(4.5rem,3rem+6vw,9rem)]',
        tone === 'darkroom' &&
          'dark border-y border-border bg-[oklch(0.135_0.004_255)] text-foreground',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** The small label above a heading; `rec` adds the vermilion record dot. */
export function Eyebrow({ children, rec = false }: { children: ReactNode; rec?: boolean }) {
  return (
    <p className="inline-flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
      {rec && <span aria-hidden className="size-2 rounded-full bg-primary" />}
      {children}
    </p>
  );
}

export function SectionTitle({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        'mt-4 font-display text-[clamp(2.25rem,1.4rem+3vw,4rem)] leading-[1.02] text-balance',
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('mt-5 max-w-xl text-lg text-pretty text-muted-foreground', className)}>
      {children}
    </p>
  );
}

/**
 * A product screenshot in a window frame, matched to the theme (both images lazy; the hidden one
 * is display:none, so the browser fetches only the visible one). `theme="dark"` always shows the
 * dark capture (inside a darkroom band).
 */
export function ProductShot({
  screen,
  alt,
  theme = 'match',
  className,
}: {
  screen: ProductScreen;
  alt: string;
  theme?: 'match' | 'dark';
  className?: string;
}) {
  const { light, dark } = PRODUCT_SCREENS[screen];
  return (
    <div
      className={cn(
        'overflow-hidden rounded-panel bg-surface-raised shadow-overlay ring-1 ring-border',
        className,
      )}
    >
      <div aria-hidden className="flex h-7 items-center gap-1.5 border-b border-border px-3">
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
        <span className="size-2 rounded-full bg-border-strong" />
      </div>
      {theme === 'match' && (
        // eslint-disable-next-line @next/next/no-img-element -- static files with declared sizes; the demo inlines them
        <img
          {...imgProps(light)}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="block h-auto w-full dark:hidden"
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- static files with declared sizes; the demo inlines them */}
      <img
        {...imgProps(dark)}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={cn('block h-auto w-full', theme === 'match' && 'hidden dark:block')}
      />
    </div>
  );
}
