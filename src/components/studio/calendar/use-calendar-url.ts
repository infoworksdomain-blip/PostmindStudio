'use client';

import { useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { dayKey } from './month';
import {
  calendarSearch,
  dateFromKey,
  parseCalendarParams,
  type CalendarFilters,
  type CalendarUrlState,
  type CalendarView,
} from './calendar-view';

// BACKLOG 25.9 — the calendar's view, day and filters live in the URL. `replace` (not push) so the
// back button leaves the calendar instead of stepping through every month looked at.

export interface CalendarUrl extends CalendarUrlState {
  /** The anchor day (today when the URL has no date). */
  anchor: Date;
  setView: (view: CalendarView) => void;
  setDate: (date: Date | null) => void;
  /** Change view and day at once (e.g. open a day from the month). */
  show: (view: CalendarView, date: Date) => void;
  setFilters: (filters: Partial<CalendarFilters>) => void;
  clearFilters: () => void;
}

export function useCalendarUrl(initialDate?: Date): CalendarUrl {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const state = useMemo(() => parseCalendarParams(params), [params]);
  const anchor = useMemo(
    () => dateFromKey(state.date) ?? initialDate ?? new Date(),
    [state.date, initialDate],
  );
  const write = (next: CalendarUrlState) => {
    const qs = calendarSearch(next, params);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return {
    ...state,
    anchor,
    setView: (view) => write({ ...state, view }),
    setDate: (date) => write({ ...state, date: date ? dayKey(date) : null }),
    show: (view, date) => write({ ...state, view, date: dayKey(date) }),
    setFilters: (filters) => write({ ...state, filters: { ...state.filters, ...filters } }),
    clearFilters: () =>
      write({ ...state, filters: { platform: null, status: null, source: null } }),
  };
}
