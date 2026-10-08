'use client';

import Link from 'next/link';
import { Play } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// BACKLOG 25.10 — the one media tile (deferred from 25.3): a poster in a frame with a declared
// aspect ratio (no layout shift while the lazy image loads), a duration badge in Geist Mono, a
// play affordance for video, an optional status / licence pill and an optional corner badge.
// The tile IS the object: no card chrome, the title and one quiet meta line sit under the frame.
// It is one link (href) or one button (onSelect), named by its visible title; the meta line and
// badges describe it. A hover / focus preview plays only when the caller can supply one
// (renderPreview), after a short pause, never under reduced motion.

const HOVER_DELAY_MS = 350;

export type MediaAspect = '9:16' | '16:9' | '1:1' | '4:5';

const ASPECT_CLASS: Record<MediaAspect, string> = {
  '9:16': 'aspect-[9/16]',
  '16:9': 'aspect-video',
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
};

/** A known aspect ratio string ('9:16', '16:9', '1:1', '4:5'), else the fallback. */
export function mediaAspect(value: string | null | undefined, fallback: MediaAspect = '9:16') {
  return value && value in ASPECT_CLASS ? (value as MediaAspect) : fallback;
}

/** The aspect a width × height is closest to. */
export function aspectOfSize(
  width: number | null | undefined,
  height: number | null | undefined,
  fallback: MediaAspect = '9:16',
): MediaAspect {
  if (!width || !height) return fallback;
  const ratio = width / height;
  const options: Array<[MediaAspect, number]> = [
    ['9:16', 9 / 16],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['16:9', 16 / 9],
  ];
  return options.reduce((best, cur) =>
    Math.abs(cur[1] - ratio) < Math.abs(best[1] - ratio) ? cur : best,
  )[0];
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

export interface MediaTileProps {
  /** The visible title under the frame; it names the link / button. */
  title: string;
  /** One quiet line under the title (category, type, date). */
  meta?: ReactNode;
  posterUrl?: string | null;
  /** Intrinsic poster size when known (declared on the <img>). */
  posterWidth?: number | null;
  posterHeight?: number | null;
  /** The frame's shape. */
  aspect?: MediaAspect;
  /** cover fills the frame; contain letterboxes on a quiet matte (mixed shapes in one grid). */
  fit?: 'cover' | 'contain';
  kind?: 'video' | 'image';
  /** A formatted duration ("0:21"), shown bottom end. */
  duration?: string;
  /** A status or licence pill (top start). */
  pill?: ReactNode;
  /** A small badge (bottom start, clear of the pill), e.g. a match score. */
  corner?: ReactNode;
  /** Shown in the frame when there is no poster. */
  fallback?: ReactNode;
  /** A muted preview played on hover / focus, only when the API can provide one. */
  renderPreview?: () => ReactNode;
  href?: string;
  onSelect?: () => void;
  className?: string;
}

const FOCUS_RING =
  'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export function MediaTile({
  title,
  meta,
  posterUrl,
  posterWidth,
  posterHeight,
  aspect = '9:16',
  fit = 'cover',
  kind = 'video',
  duration,
  pill,
  corner,
  fallback,
  renderPreview,
  href,
  onSelect,
  className,
}: MediaTileProps) {
  const titleId = useId();
  const metaId = useId();
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const canPreview = Boolean(renderPreview) && !reducedMotion;

  const start = () => {
    if (!canPreview) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPreviewing(true), HOVER_DELAY_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPreviewing(false);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const body = (
    <>
      <span
        data-slot="media-frame"
        className={cn(
          'relative block overflow-hidden rounded-lg bg-secondary',
          fit === 'contain' && 'bg-surface-raised dark:bg-black/60',
          ASPECT_CLASS[aspect],
        )}
      >
        {posterUrl ? (
          // Signed, short-lived storage URLs: next/image would need every bucket host allowlisted.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={posterUrl}
            alt=""
            loading="lazy"
            decoding="async"
            width={posterWidth ?? undefined}
            height={posterHeight ?? undefined}
            className={cn(
              'absolute inset-0 size-full',
              fit === 'cover' ? 'object-cover' : 'object-contain',
              'motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-standard motion-safe:group-hover:scale-[1.03]',
            )}
          />
        ) : (
          <span aria-hidden className="absolute inset-0 grid place-items-center">
            {fallback}
          </span>
        )}
        {previewing && renderPreview?.()}
        {kind === 'video' && (
          <span
            aria-hidden
            data-slot="media-play"
            className="absolute inset-0 m-auto grid size-10 place-items-center rounded-full bg-scrim/60 text-white opacity-0 backdrop-blur-sm transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Play className="size-4 translate-x-px fill-current" />
          </span>
        )}
        {pill && <span className="absolute top-2 start-2 max-w-[calc(100%-1rem)]">{pill}</span>}
        {corner && <span className="absolute start-2 bottom-2">{corner}</span>}
        {duration && (
          <span
            data-slot="media-duration"
            className="absolute end-2 bottom-2 rounded-sm bg-scrim/75 px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none font-medium text-white"
          >
            {duration}
          </span>
        )}
      </span>
      <span className="mt-2 block min-w-0 px-0.5">
        <span
          id={titleId}
          className="block truncate text-sm font-medium text-foreground group-hover:underline group-hover:underline-offset-2"
        >
          {title}
        </span>
        {meta && (
          <span id={metaId} className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </span>
    </>
  );

  const shared = {
    'aria-labelledby': titleId,
    'aria-describedby': meta ? metaId : undefined,
    onMouseEnter: start,
    onMouseLeave: stop,
    onFocus: start,
    onBlur: stop,
    'data-slot': 'media-tile',
    className: cn('group block w-full min-w-0 text-start', FOCUS_RING, className),
  };

  return href ? (
    <Link href={href} {...shared}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onSelect} {...shared}>
      {body}
    </button>
  );
}
