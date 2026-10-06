'use client';

import { useEffect, type RefObject } from 'react';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { useDebounced } from './use-debounced';
import { useLiveProjects, type LiveProjects } from './use-live-projects';

// 24.2 — a polling screen (month plan, Blitz) that switches to live events: each matching event
// refreshes the screen once (debounced); `liveOpen` tells the screen's SWR refreshInterval to stop
// polling while the stream is open, and going back to polling kicks one refresh so SWR schedules
// its interval again.

export const LIVE_REFRESH_DEBOUNCE_MS = 1_000;

export function useLiveRefetch(
  idsKey: string,
  refetch: () => void,
  liveOpen: RefObject<boolean>,
  shouldRefetch: (event: LiveProjectEvent) => boolean = () => true,
): LiveProjects {
  const refreshSoon = useDebounced(refetch, LIVE_REFRESH_DEBOUNCE_MS);
  const live = useLiveProjects(idsKey, (event) => {
    if (shouldRefetch(event)) refreshSoon();
  });
  useEffect(() => {
    liveOpen.current = live.mode === 'live';
    if (live.mode === 'polling') refetch();
    // `refetch` changes identity every render; only a mode change matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.mode, liveOpen]);
  return live;
}
