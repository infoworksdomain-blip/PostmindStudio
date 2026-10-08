'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { DURATION_FILTERS } from './library-utils';

// BACKLOG 25.10 — the library's filters live in the URL (?q=&category=&length=&mood=&tags=), so a
// filtered view can be shared and survives a reload. Changing a filter replaces the history entry
// (Back leaves the library rather than stepping through filters) and shows at once; a URL that
// changes from outside (a link to /library?category=…) wins again.

export interface LibraryFilterState {
  category: string;
  duration: string;
  mood: string;
  tags: string;
  search: string;
}

export const EMPTY_FILTERS: LibraryFilterState = {
  category: '',
  duration: 'any',
  mood: '',
  tags: '',
  search: '',
};

const PARAM: Record<keyof LibraryFilterState, string> = {
  search: 'q',
  category: 'category',
  duration: 'length',
  mood: 'mood',
  tags: 'tags',
};
const MAX_PARAM_LENGTH = 200;

/** The filters a query string asks for; unknown lengths fall back to "any". */
export function filtersFromSearch(search: string): LibraryFilterState {
  const params = new URLSearchParams(search);
  const read = (key: keyof LibraryFilterState) =>
    (params.get(PARAM[key]) ?? '').slice(0, MAX_PARAM_LENGTH);
  const duration = read('duration');
  return {
    search: read('search'),
    category: read('category'),
    duration: DURATION_FILTERS.some((d) => d.key === duration) ? duration : 'any',
    mood: read('mood'),
    tags: read('tags'),
  };
}

/** The query string for the filters (`?…`, or '' when nothing is filtered). */
export function searchFromFilters(filters: LibraryFilterState): string {
  const params = new URLSearchParams();
  (Object.keys(PARAM) as Array<keyof LibraryFilterState>).forEach((key) => {
    const value = filters[key].trim();
    if (value && !(key === 'duration' && value === 'any')) params.set(PARAM[key], value);
  });
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useLibraryParams(): {
  filters: LibraryFilterState;
  setFilters: (next: LibraryFilterState) => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = useSearchParams()?.toString() ?? '';
  // The last choice, remembered against the URL it replaced (see use-tab-param.ts).
  const [chosen, setChosen] = useState<{ filters: LibraryFilterState; over: string } | null>(null);
  const filters = chosen && chosen.over === fromUrl ? chosen.filters : filtersFromSearch(fromUrl);

  const setFilters = (next: LibraryFilterState) => {
    setChosen({ filters: next, over: fromUrl });
    router.replace(`${pathname ?? '/library'}${searchFromFilters(next)}`, { scroll: false });
  };
  return { filters, setFilters };
}
