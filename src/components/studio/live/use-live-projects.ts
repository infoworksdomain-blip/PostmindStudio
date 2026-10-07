'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPath, useApi } from '@/lib/client/api';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { anyInProgress, mergeStatuses, parseLiveEvent, type LiveMode } from './live-model';

// BACKLOG 24.2 — live project status in the browser. Opens one EventSource on
// /api/studio/live/projects (the session cookie authenticates it; the server picks the
// organisation). While it is open nothing polls. If EventSource is missing, the server answers
// 503 (no bus), or the stream errors MAX_ERRORS times in a row, the hook reports `polling` and
// the screens fall back to their previous refresh intervals; it tries the stream again after
// RETRY_LIVE_MS. GET /live/projects/status gives the starting statuses of the ids on screen.

export const MAX_ERRORS = 3;
export const RETRY_LIVE_MS = 120_000;
export const FALLBACK_POLL_MS = 15_000;
const LIVE_PATH = '/live/projects';

export interface LiveProjects {
  mode: LiveMode;
  statuses: ReadonlyMap<string, LiveProjectEvent>;
}

function liveSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.EventSource === 'function';
}

/**
 * @param idsKey comma-separated project ids on screen (live-model.ts idsKey), '' for none.
 * @param onEvent called for every `project` event (e.g. revalidate the screen's data).
 */
export function useLiveProjects(
  idsKey: string,
  onEvent?: (event: LiveProjectEvent) => void,
): LiveProjects {
  const [mode, setMode] = useState<LiveMode>(() => (liveSupported() ? 'connecting' : 'polling'));
  const [events, setEvents] = useState<ReadonlyMap<string, LiveProjectEvent>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!liveSupported()) return;
    let errors = 0;
    let retry: number | undefined;
    const source = new window.EventSource(apiPath(LIVE_PATH));
    const fallBack = () => {
      source.close();
      setMode('polling');
      retry = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_LIVE_MS);
    };
    source.addEventListener('ready', () => {
      errors = 0;
      setMode('live');
    });
    source.addEventListener('project', (e: MessageEvent<string>) => {
      const event = parseLiveEvent(e.data);
      if (!event) return;
      setEvents((known) => mergeStatuses(known, [event]));
      onEventRef.current?.(event);
    });
    source.addEventListener('unavailable', fallBack);
    source.onerror = () => {
      errors += 1;
      if (errors >= MAX_ERRORS || source.readyState === window.EventSource.CLOSED) fallBack();
      else setMode('connecting');
    };
    return () => {
      source.close();
      if (retry) window.clearTimeout(retry);
    };
  }, [attempt]);

  const { data } = useApi<{ projects: LiveProjectEvent[] }>(
    idsKey ? `${LIVE_PATH}/status` : null,
    { ids: idsKey },
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
      refreshInterval: (latest) =>
        mode === 'polling' &&
        latest &&
        anyInProgress(mergeStatuses(new Map(), latest.projects ?? []))
          ? FALLBACK_POLL_MS
          : 0,
    },
  );

  const statuses = useMemo(
    () => mergeStatuses(mergeStatuses(new Map(), data?.projects ?? []), [...events.values()]),
    [data, events],
  );
  return { mode, statuses };
}
