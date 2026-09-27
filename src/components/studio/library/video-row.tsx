'use client';

import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoCard } from './video-card';
import type { LibraryVideoSummary } from './types';

// A horizontally scrolling shelf of reference videos (recommended, similar).

export function VideoRow({
  label,
  videos,
  isLoading,
  empty,
}: {
  label: string;
  videos: LibraryVideoSummary[] | undefined;
  isLoading: boolean;
  empty?: ReactNode;
}) {
  if (isLoading) {
    return (
      <div aria-label={`Loading ${label}`} className="flex gap-4 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="aspect-[4/5] w-36 shrink-0 rounded-xl sm:w-44" />
        ))}
      </div>
    );
  }
  if (!videos || videos.length === 0) return <>{empty ?? null}</>;
  return (
    <ul
      aria-label={label}
      className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:thin]"
    >
      {videos.map((v) => (
        <li key={v.id} className="w-36 shrink-0 snap-start sm:w-44">
          <VideoCard video={v} size="sm" />
        </li>
      ))}
    </ul>
  );
}
