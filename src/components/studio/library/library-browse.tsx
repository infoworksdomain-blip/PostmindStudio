'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { EMPTY_FILTERS, LibraryFilters, type LibraryFilterState } from './library-filters';
import { DURATION_FILTERS, flattenCategories, parseTags } from './library-utils';
import { RecommendedShelf } from './recommended-shelf';
import type { CategoryNode, LibraryVideoSummary, ListResponse } from './types';
import { useLibrarySearch } from './use-library-search';
import { VideoCard } from './video-card';

// BACKLOG 10.7 / Addendum A3.1 — browse the reference library: recommended shelf, taxonomy
// filters, a grid of previews with cursor pagination. A search (13.8) queries the whole library
// on the server (POST /library/search: meaning, plus title/tag words), within the category.

const PAGE_SIZE = 24;

export function LibraryBrowse() {
  const t = useTranslations('library.browse');
  const tc = useTranslations('common.actions');
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_FILTERS);
  const [cursors, setCursors] = useState<string[]>([]);
  const categories = useApi<ListResponse<CategoryNode>>('/library/categories');
  const categoryOptions = useMemo(
    () => flattenCategories(categories.data?.data ?? []),
    [categories.data],
  );

  const duration = DURATION_FILTERS.find((d) => d.key === filters.duration);
  const tags = parseTags(filters.tags);
  const query = filters.search.trim();
  const searching = query !== '';
  const list = useApi<ListResponse<LibraryVideoSummary>>(searching ? null : '/library/videos', {
    category: filters.category || undefined,
    tags: tags.length ? tags.join(',') : undefined,
    mood: filters.mood || undefined,
    durationMin: duration?.min,
    durationMax: duration?.max,
    cursor: cursors.at(-1),
    limit: PAGE_SIZE,
  });
  const search = useLibrarySearch(
    searching
      ? {
          q: query,
          categorySlug: filters.category || undefined,
          cursor: cursors.at(-1),
          limit: PAGE_SIZE,
        }
      : null,
  );
  const { data, error, isLoading, mutate } = searching ? search : list;
  const visible: LibraryVideoSummary[] = data?.data ?? [];

  const applyFilters = (next: LibraryFilterState) => {
    setFilters(next);
    setCursors([]);
  };

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />

      <RecommendedShelf category={filters.category} />

      <section aria-labelledby="library-browse" className="min-w-0">
        <h2 id="library-browse" className="mb-3 font-display text-2xl">
          {t('heading')}
        </h2>
        <LibraryFilters value={filters} categories={categoryOptions} onChange={applyFilters} />

        {searching && (
          <p className="mt-3 text-sm text-muted-foreground" role="status">
            {filters.category
              ? t('searchStatusInCategory', { query })
              : t('searchStatus', { query })}
          </p>
        )}
        <div className="mt-6">
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && (
            <div
              aria-label={t('loading')}
              className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            >
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="aspect-[9/14] rounded-xl" />
              ))}
            </div>
          )}
          {data && visible.length === 0 && (
            <EmptyState
              illustration="library"
              title={t('emptyTitle')}
              description={searching ? t('emptySearch') : t('emptyFilters')}
            />
          )}
          {data && visible.length > 0 && (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {visible.map((v) => (
                <li key={v.id} className="min-w-0">
                  <VideoCard video={v} />
                </li>
              ))}
            </ul>
          )}
          {data && (cursors.length > 0 || data.nextCursor) && (
            <div className="mt-8 flex justify-between">
              <Button
                variant="ghost"
                disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                {tc('previous')}
              </Button>
              <Button
                variant="ghost"
                disabled={!data.nextCursor}
                onClick={() =>
                  data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])
                }
              >
                {t('more')}
              </Button>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
