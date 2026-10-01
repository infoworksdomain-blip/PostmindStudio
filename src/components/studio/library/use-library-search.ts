'use client';

import useSWR from 'swr';
import { api, type ApiError } from '@/lib/client/api';
import type { ListResponse, LibraryVideoSummary } from './types';

// BACKLOG 13.8 — POST /library/search { q, categorySlug?, limit, cursor } (the query is embedded
// server-side, so it is a POST). SWR keys on the arguments; null skips.

export interface LibrarySearchArgs {
  q: string;
  categorySlug?: string;
  /** The browse filters, honoured by the search too. */
  durationMin?: number;
  durationMax?: number;
  mood?: string;
  tags?: string[];
  cursor?: string;
  limit: number;
}

export type SearchResult = LibraryVideoSummary & { similarity: number; score: number };

export function useLibrarySearch(args: LibrarySearchArgs | null) {
  return useSWR<ListResponse<SearchResult>, ApiError>(
    args
      ? [
          'library-search',
          args.q,
          args.categorySlug ?? '',
          args.durationMin ?? '',
          args.durationMax ?? '',
          args.mood ?? '',
          (args.tags ?? []).join(','),
          args.cursor ?? '',
          args.limit,
        ]
      : null,
    () =>
      api<ListResponse<SearchResult>>('/library/search', {
        method: 'POST',
        body: {
          q: args?.q,
          ...(args?.categorySlug && { categorySlug: args.categorySlug }),
          ...(args?.durationMin !== undefined && { durationMin: args.durationMin }),
          ...(args?.durationMax !== undefined && { durationMax: args.durationMax }),
          ...(args?.mood && { mood: args.mood }),
          ...(args?.tags?.length && { tags: args.tags }),
          limit: args?.limit,
          cursor: args?.cursor ?? null,
        },
      }),
    { revalidateOnFocus: false },
  );
}
