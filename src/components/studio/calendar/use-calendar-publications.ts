'use client';

import useSWR from 'swr';
import { api, type ApiError } from '@/lib/client/api';
import type { Page, Publication } from '@/lib/client/types';

// GET /publications supports a from/to window (scheduledFor or publishedAt) and pages of up to
// 200. A month rarely holds more, but the fetch follows the cursor for at most MAX_PAGES pages
// so a busy agency account can never turn one calendar view into an unbounded crawl.

export const CALENDAR_STATES = 'SCHEDULED,PUBLISHING,PUBLISHED,FAILED';
export const PAGE_LIMIT = 200;
export const MAX_PAGES = 5;

export interface CalendarData {
  publications: Publication[];
  /** True when MAX_PAGES was reached and more publications exist in the window. */
  truncated: boolean;
}

export async function fetchWindow(from: string, to: string): Promise<CalendarData> {
  const publications: Publication[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await api<Page<Publication>>('/publications', {
      query: { state: CALENDAR_STATES, from, to, limit: PAGE_LIMIT, cursor },
    });
    publications.push(...res.data);
    if (!res.nextCursor) return { publications, truncated: false };
    cursor = res.nextCursor;
  }
  return { publications, truncated: true };
}

/** @param refreshMs 24.2: refresh interval while live status is unavailable (0 = none). */
export function useCalendarPublications(from: string, to: string, refreshMs = 0) {
  return useSWR<CalendarData, ApiError>(
    ['studio-calendar', from, to],
    ([, f, t]: [string, string, string]) => fetchWindow(f, t),
    { revalidateOnFocus: false, keepPreviousData: true, refreshInterval: refreshMs },
  );
}
