'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { useAnalysisLabels } from './analysis-labels';
import type { LibraryVideoDetail, LibraryVideoSummary } from './types';
import { EmptyIllustration } from '../empty-illustration';

// One reference video in a grid. List results carry only a thumbnail (A3.10: the preview
// rendition is signed per detail request), so hovering/focusing for a moment fetches the detail
// and plays the muted, low-res preview in place.

const HOVER_DELAY_MS = 350;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
  }, []);
  return reduced;
}

function HoverPreview({ id }: { id: string }) {
  const { data } = useApi<{ ok: true; video: LibraryVideoDetail }>(`/library/videos/${id}`);
  const url = data?.video.previewUrl;
  if (!url) return null;
  return (
    <video
      data-testid="hover-preview"
      src={url}
      muted
      autoPlay
      loop
      playsInline
      aria-hidden
      className="absolute inset-0 size-full object-cover"
    />
  );
}

export function VideoCard({
  video,
  className,
  size = 'md',
}: {
  video: LibraryVideoSummary;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('library.card');
  const f = useFormat();
  const labels = useAnalysisLabels();
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const start = () => {
    if (reducedMotion) return;
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

  const templateAllowed = video.allowedModes.includes('TEMPLATE');

  return (
    <Link
      href={`/library/${video.id}`}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
      className={cn(
        'group block min-w-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
        className,
      )}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-xl bg-secondary',
          size === 'sm' ? 'aspect-[4/5]' : 'aspect-[9/14]',
        )}
      >
        {video.thumbnailUrl ? (
          // Signed, short-lived storage URLs: next/image would need every bucket host allowlisted.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnailUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <EmptyIllustration name="library" className="absolute inset-0 m-auto h-auto w-4/5" />
        )}
        {previewing && <HoverPreview id={video.id} />}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2.5 pt-10 text-[0.7rem] font-medium text-white">
          <span className="tabular rounded bg-black/40 px-1.5 py-0.5">
            {f.duration(video.durationSec)}
          </span>
          <span className="rounded bg-black/40 px-1.5 py-0.5">
            {templateAllowed ? t('templateAndInspire') : t('inspireOnly')}
          </span>
        </div>
        {typeof video.similarity === 'number' && (
          <span className="tabular absolute top-2 start-2 rounded-full bg-background/90 px-2 py-0.5 text-[0.7rem] font-medium">
            {t('match', { percent: f.percent(video.similarity) })}
          </span>
        )}
      </div>
      <div className="mt-2.5 min-w-0 px-0.5">
        <p className="truncate text-sm font-medium group-hover:underline">{video.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {video.category.name}
          {video.analysis &&
            ` · ${labels.pace(video.analysis.paceTag)} · ${video.analysis.moodTag}`}
        </p>
      </div>
    </Link>
  );
}
