'use client';

import useSWR from 'swr';
import { api, errorMessage, type ApiError } from '@/lib/client/api';
import { VideoRow } from './video-row';
import type { LibraryVideoSummary, ListResponse } from './types';

// A3.5 operation 1 — "more like this" (POST /library/videos/:id/similar, a read despite the
// verb: the body only carries the limit).

const SIMILAR_LIMIT = 12;

export function SimilarShelf({ id }: { id: string }) {
  const { data, error, isLoading } = useSWR<ListResponse<LibraryVideoSummary>, ApiError>(
    ['library-similar', id],
    () =>
      api<ListResponse<LibraryVideoSummary>>(`/library/videos/${id}/similar`, {
        method: 'POST',
        body: { limit: SIMILAR_LIMIT },
      }),
    { revalidateOnFocus: false },
  );
  return (
    <section aria-labelledby="library-similar" className="min-w-0">
      <h2 id="library-similar" className="mb-4 font-display text-2xl">
        More like this
      </h2>
      {error ? (
        <p className="text-sm text-muted-foreground">
          Similar videos are unavailable: {errorMessage(error)}
        </p>
      ) : (
        <VideoRow
          label="Similar references"
          videos={data?.data}
          isLoading={isLoading}
          empty={<p className="text-sm text-muted-foreground">No close neighbours yet.</p>}
        />
      )}
    </section>
  );
}
