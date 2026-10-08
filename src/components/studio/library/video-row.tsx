'use client';

import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoCard } from './video-card';
import type { LibraryVideoSummary } from './types';

// A shelf: one horizontal row of reference tiles (recommended, similar). It scrolls sideways
// with snap points; each tile is a link, so Tab walks the row and brings each tile into view.

const TILE_WIDTH = 'w-[9.5rem] sm:w-44 lg:w-48';

export function VideoRow({
  label,
  loadingLabel,
  videos,
  isLoading,
  empty,
}: {
  label: string;
  /** Accessible name of the loading skeleton. */
  loadingLabel: string;
  videos: LibraryVideoSummary[] | undefined;
  isLoading: boolean;
  empty?: ReactNode;
}) {
  if (isLoading) {
    return (
      <div aria-label={loadingLabel} className="flex gap-4 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className={`aspect-[9/16] shrink-0 rounded-lg ${TILE_WIDTH}`} />
        ))}
      </div>
    );
  }
  if (!videos || videos.length === 0) return <>{empty ?? null}</>;
  return (
    <ul
      aria-label={label}
      className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-4 overflow-x-auto px-1 pt-1 pb-3 [scrollbar-width:thin]"
    >
      {videos.map((v) => (
        <li key={v.id} className={`shrink-0 snap-start ${TILE_WIDTH}`}>
          <VideoCard video={v} />
        </li>
      ))}
    </ul>
  );
}
