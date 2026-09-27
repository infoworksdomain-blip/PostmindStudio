'use client';

import useSWR from 'swr';
import { api, type ApiError } from '@/lib/client/api';
import type { ListResponse, LibraryVideoSummary } from './types';

// BACKLOG 13.8 — POST /library/search { q, categorySlug?, limit, cursor } (the query is embedded
// server-side, so it is a POST). SWR keys on the arguments; null skips.

export interface LibrarySearchArgs {
  q: string;
  categorySlug?: string;
  cursor?: string;
  limit: number;
}

export type SearchResult = LibraryVideoSummary & { similarity: number; score: number };

export function useLibrarySearch(args: LibrarySearchArgs | null) {
  return useSWR<ListResponse<SearchResult>, ApiError>(
    args
      ? ['library-search', args.q, args.categorySlug ?? '', args.cursor ?? '', args.limit]
      : null,
    () =>
      api<ListResponse<SearchResult>>('/library/search', {
        method: 'POST',
        body: {
          q: args?.q,
          ...(args?.categorySlug && { categorySlug: args.categorySlug }),
          limit: args?.limit,
          cursor: args?.cursor ?? null,
        },
      }),
    { revalidateOnFocus: false },
  );
}
