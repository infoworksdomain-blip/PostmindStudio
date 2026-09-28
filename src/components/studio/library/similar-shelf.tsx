'use client';

import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { api, useErrorMessage, type ApiError } from '@/lib/client/api';
import { VideoRow } from './video-row';
import type { LibraryVideoSummary, ListResponse } from './types';

// A3.5 operation 1 — "more like this" (POST /library/videos/:id/similar, a read despite the
// verb: the body only carries the limit).

const SIMILAR_LIMIT = 12;

export function SimilarShelf({ id }: { id: string }) {
  const t = useTranslations('library.similar');
  const errorMessage = useErrorMessage();
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
        {t('heading')}
      </h2>
      {error ? (
        <p className="text-sm text-muted-foreground">
          {t('unavailable', { error: errorMessage(error) })}
        </p>
      ) : (
        <VideoRow
          label={t('listAria')}
          loadingLabel={t('loading')}
          videos={data?.data}
          isLoading={isLoading}
          empty={<p className="text-sm text-muted-foreground">{t('empty')}</p>}
        />
      )}
    </section>
  );
}
