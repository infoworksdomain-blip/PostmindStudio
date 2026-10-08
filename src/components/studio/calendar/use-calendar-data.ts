'use client';

import { useEffect, useMemo, useState } from 'react';
import { IN_PROGRESS_STAGES } from '@/lib/studio/live/eta';
import { useBusiness } from '../business-context';
import { idsKey } from '../live/live-model';
import { useDebounced } from '../live/use-debounced';
import { useLiveProjects } from '../live/use-live-projects';
import {
  filterPublications,
  hasFilters,
  plannedMatches,
  platformsIn,
  type CalendarFilters,
} from './calendar-view';
import { dayKey, groupByDay, groupOpenByDay } from './month';
import { groupPlannedByDay } from './planned-slot';
import { useCalendarPublications } from './use-calendar-publications';
import { summaryWindow, useUpcomingSlots } from './use-upcoming-slots';

/** 24.2: refresh the view this long after the last live event that changed a post. */
const LIVE_REFRESH_DEBOUNCE_MS = 1_000;
/** 24.2: while live status is unavailable, the view refreshes itself this often. */
const FALLBACK_REFRESH_MS = 60_000;

// BACKLOG 25.9 — everything the calendar shows for one window (a month grid, a week or a day):
// the publications (GET /publications?from&to), the open posting times and month-plan posts
// still being made (…/drip-queue/upcoming), the "Next 30 days" summary, the live status stream
// (24.2) that refreshes the window instead of polling, and the filters applied on the client.

export function useCalendarData(range: { from: string; to: string }, filters: CalendarFilters) {
  const [polling, setPolling] = useState(false);
  const publications = useCalendarPublications(
    range.from,
    range.to,
    polling ? FALLBACK_REFRESH_MS : 0,
  );
  const { businessId } = useBusiness();
  const [openedAt] = useState(() => Date.now());
  const summary = useUpcomingSlots(businessId, summaryWindow(openedAt), openedAt);
  const visible = useUpcomingSlots(businessId, range, openedAt, polling ? FALLBACK_REFRESH_MS : 0);
  const all = useMemo(() => publications.data?.publications ?? [], [publications.data]);
  const allPlanned = useMemo(() => visible.data?.upcoming?.planned ?? [], [visible.data]);
  // 24.2: live status of every post on screen; a post that finishes, fails or posts refreshes
  // the window (debounced) instead of the calendar polling.
  const liveIds = idsKey([...all.map((p) => p.projectId), ...allPlanned.map((p) => p.projectId)]);
  const refreshSoon = useDebounced(() => {
    void publications.mutate();
    void visible.mutate();
  }, LIVE_REFRESH_DEBOUNCE_MS);
  const live = useLiveProjects(liveIds, (event) => {
    if (!event.stage || !IN_PROGRESS_STAGES.has(event.stage)) refreshSoon();
  });
  const livePolling = live.mode === 'polling';
  useEffect(() => setPolling(livePolling), [livePolling]);

  const shown = useMemo(() => filterPublications(all, filters), [all, filters]);
  const planned = useMemo(
    () => allPlanned.filter((post) => plannedMatches(post, filters)),
    [allPlanned, filters],
  );
  const byDay = useMemo(() => groupByDay(shown), [shown]);
  const plannedByDay = useMemo(() => groupPlannedByDay(planned, dayKey), [planned]);
  // Open posting times are not posts: they only show while nothing is filtered.
  const openByDay = useMemo(
    () =>
      hasFilters(filters)
        ? new Map<string, string[]>()
        : groupOpenByDay(visible.data?.upcoming?.openSlots ?? []),
    [visible.data, filters],
  );
  const platforms = useMemo(() => platformsIn(all, filters.platform), [all, filters.platform]);

  return {
    publications,
    summary,
    live,
    byDay,
    plannedByDay,
    openByDay,
    platforms,
    shownCount: shown.length + planned.length,
    totalCount: all.length + allPlanned.length,
    refresh: () => {
      void publications.mutate();
      void summary.mutate();
      void visible.mutate();
    },
    refreshSlots: () => {
      void summary.mutate();
      void visible.mutate();
    },
  };
}
