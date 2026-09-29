import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { sampleVideo, sceneImage, type Aspect, type SceneKind } from '../media';
import { useLocation } from '../router';

// Shared building blocks for the demo tour pages. They use the app's own tokens (globals.css) and
// type scale (Instrument Serif display, Inter body) so the tour reads as part of the product.

export function TourHeader({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-10 border-b border-border/70 pb-8">
      <p className="mb-3 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1 className="max-w-3xl font-display text-5xl leading-[0.95] md:text-6xl">{title}</h1>
      <div className="mt-4 max-w-2xl text-base text-muted-foreground">{lede}</div>
      {children}
    </header>
  );
}

/** Numbered chapter heading: a vermilion index, serif title, one-line description. */
export function Chapter({
  id,
  index,
  title,
  description,
  children,
}: {
  id: string;
  index: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 py-10 first:pt-0">
      <div className="mb-6 grid gap-2 md:grid-cols-[4.5rem_1fr]">
        <span className="font-display text-3xl leading-none text-primary tabular-nums">
          {index}
        </span>
        <div>
          <h2 id={`${id}-h`} className="font-display text-3xl leading-tight md:text-4xl">
            {title}
          </h2>
          {description && (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="md:pl-[4.5rem]">{children}</div>
    </section>
  );
}

export function Panel({
  title,
  meta,
  children,
  className,
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-border bg-card p-5', className)}>
      {(title || meta) && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Terminal / file excerpt. `label` names the source file or command. */
export function Code({ label, children }: { label: string; children: string }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border border-border bg-foreground text-background">
      <figcaption className="flex items-center gap-2 border-b border-background/15 px-3 py-1.5 font-mono text-[0.7rem] text-background/70">
        <span aria-hidden className="size-2 rounded-full bg-primary" />
        {label}
      </figcaption>
      <pre
        tabIndex={0}
        className="max-h-[26rem] overflow-auto px-4 py-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {children}
      </pre>
    </figure>
  );
}

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'live' | 'good' | 'warn' | 'bad' | 'data';
}) {
  const TONE = {
    neutral: 'bg-secondary text-secondary-foreground',
    live: 'bg-primary/10 text-primary',
    good: 'bg-success/12 text-success',
    warn: 'bg-warning/20 text-foreground',
    bad: 'bg-destructive/12 text-destructive',
    data: 'bg-accent text-accent-foreground',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[0.7rem] font-medium whitespace-nowrap',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

const ASPECT_CLASS: Record<Aspect, string> = {
  '9:16': 'aspect-[9/16]',
  '16:9': 'aspect-video',
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
};

/** A sample illustration (drawn on a canvas, labelled SAMPLE by media.ts). */
export function SceneThumb({
  scene,
  aspect = '16:9',
  className,
  alt = '',
}: {
  scene: SceneKind;
  aspect?: Aspect;
  className?: string;
  alt?: string;
}) {
  const [w, h] = aspect === '9:16' ? [270, 480] : aspect === '16:9' ? [480, 270] : [360, 360];
  const src = sceneImage(scene, w, h);
  return (
    <div className={cn('overflow-hidden bg-muted', ASPECT_CLASS[aspect], className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- canvas data: URL in the static demo; next/image isn't available outside Next.js */}
      {src && <img src={src} alt={alt} className="size-full object-cover" loading="lazy" />}
    </div>
  );
}

/**
 * A short recorded sample clip. Recording starts only when the tile scrolls into view (clips
 * are recorded live in the browser, so off-screen ones would waste time); until then, and where
 * the browser cannot record, the still illustration is shown.
 */
export function SceneVideo({
  scene,
  aspect = '9:16',
  caption,
  className,
  label,
}: {
  scene: SceneKind;
  aspect?: Aspect;
  caption?: string;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const start = () => {
      void sampleVideo({ scene, aspect, seconds: 4, caption }).then((url) => {
        if (alive) setSrc(url);
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      start();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        start();
      }
    });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [scene, aspect, caption]);
  return (
    <div
      ref={ref}
      className={cn('relative overflow-hidden bg-muted', ASPECT_CLASS[aspect], className)}
    >
      {src ? (
        <video
          src={src}
          className="size-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          aria-label={label}
        />
      ) : (
        <SceneThumb scene={scene} aspect={aspect} className="size-full" alt={label} />
      )}
    </div>
  );
}

/** Small key/value table used by several behind-the-scenes panels. */
export function DataTable({
  head,
  rows,
  caption,
}: {
  head: string[];
  rows: ReactNode[][];
  caption?: string;
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[20rem] text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {head.map((h) => (
              <th key={h} scope="col" className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="py-2 pr-4 align-top tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** In-page table of contents (anchor links scroll within the page; they don't change the route). */
export function Toc({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-1.5">
      {items.map((i) => (
        <button
          key={i.id}
          type="button"
          onClick={() => document.getElementById(i.id)?.scrollIntoView({ behavior: 'smooth' })}
          className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {i.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * Deep links into a tour page: `#/tour/system?section=backup` scrolls to the element with that
 * id once the page has rendered (and again when only the query changes).
 */
export function useSectionScroll(): void {
  const { search } = useLocation();
  useEffect(() => {
    const id = new URLSearchParams(search).get('section');
    if (!id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [search]);
}
