'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader } from '../primitives';
import { LibraryFilters } from './library-filters';
import { DURATION_FILTERS, flattenCategories, parseTags } from './library-utils';
import { RecommendedShelf } from './recommended-shelf';
import type { CategoryNode, LibraryVideoSummary, ListResponse } from './types';
import { searchFromFilters, useLibraryParams, type LibraryFilterState } from './use-library-params';
import { useLibrarySearch } from './use-library-search';
import { VideoCard } from './video-card';

// BACKLOG 10.7 / Addendum A3.1, redesigned in 25.10 — browse the reference library like a media
// library: the recommended shelf, then one calm toolbar (search, category, length, mood, tags;
// kept in the URL) over a grid of tiles with cursor pages. A search (13.8) queries the whole
// library on the server (POST /library/search: meaning, plus title/tag words), within the
// category and the length, mood and tag filters.

const PAGE_SIZE = 24;
/** Browse-a-category suggestions under "No close matches". */
const MAX_SUGGESTED_CATEGORIES = 8;
export const LIBRARY_GRID =
  'grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6';

/** Cursor pages, forgotten whenever the filters change (here or in the URL). */
function usePages(filters: LibraryFilterState) {
  const key = searchFromFilters(filters);
  const [pages, setPages] = useState<{ key: string; cursors: string[] }>({ key, cursors: [] });
  const cursors = pages.key === key ? pages.cursors : [];
  return {
    cursors,
    next: (cursor: string) => setPages({ key, cursors: [...cursors, cursor] }),
    previous: () => setPages({ key, cursors: cursors.slice(0, -1) }),
  };
}

export function LibraryBrowse() {
  const t = useTranslations('library.browse');
  const tc = useTranslations('common.actions');
  const tn = useTranslations('shell.nav.groups');
  const f = useFormat();
  const { filters, setFilters } = useLibraryParams();
  const { cursors, next, previous } = usePages(filters);
  const categories = useApi<ListResponse<CategoryNode>>('/library/categories');
  const categoryOptions = useMemo(
    () => flattenCategories(categories.data?.data ?? []),
    [categories.data],
  );

  const topCategories = categoryOptions
    .filter((c) => c.depth === 0)
    .slice(0, MAX_SUGGESTED_CATEGORIES);
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
          durationMin: duration?.min,
          durationMax: duration?.max,
          mood: filters.mood.trim() || undefined,
          tags: tags.length ? tags : undefined,
          cursor: cursors.at(-1),
          limit: PAGE_SIZE,
        }
      : null,
  );
  const { data, error, isLoading, mutate } = searching ? search : list;
  const visible: LibraryVideoSummary[] = data?.data ?? [];
  const paged = cursors.length > 0 || Boolean(data?.nextCursor);

  return (
    <>
      <PageHeader eyebrow={tn('library')} title={t('title')} description={t('description')} />

      <RecommendedShelf category={filters.category} />

      <section aria-labelledby="library-browse" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="library-browse" className="text-lg font-semibold tracking-tight">
            {t('heading')}
          </h2>
          {searching && (
            <p className="text-sm text-muted-foreground" role="status">
              {filters.category
                ? t('searchStatusInCategory', { query })
                : t('searchStatus', { query })}
            </p>
          )}
        </div>
        <LibraryFilters value={filters} categories={categoryOptions} onChange={setFilters} />

        <div className="mt-6 border-t border-border pt-6">
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && (
            <div aria-label={t('loading')} className={LIBRARY_GRID}>
              {Array.from({ length: 12 }, (_, i) => (
                <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
              ))}
            </div>
          )}
          {data && visible.length === 0 && (
            <EmptyState
              media="library"
              title={searching ? t('noCloseTitle', { query }) : t('emptyTitle')}
              description={searching ? t('noCloseBody') : t('emptyFilters')}
              action={
                searching && topCategories.length > 0 ? (
                  <ul className="flex flex-wrap justify-center gap-2">
                    {topCategories.map((c) => (
                      <li key={c.slug}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setFilters({ ...filters, search: '', category: c.slug })}
                        >
                          {c.label}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : undefined
              }
            />
          )}
          {data && visible.length > 0 && (
            <ul aria-label={t('gridAria')} className={LIBRARY_GRID}>
              {visible.map((v) => (
                <li key={v.id} className="min-w-0">
                  <VideoCard video={v} />
                </li>
              ))}
            </ul>
          )}
          {data && paged && (
            <nav
              aria-label={t('pagesAria')}
              className="mt-10 flex items-center justify-between gap-3 border-t border-border pt-4"
            >
              <Button variant="ghost" disabled={cursors.length === 0} onClick={previous}>
                <ChevronLeft className="rtl:-scale-x-100" /> {tc('previous')}
              </Button>
              <span className="font-mono text-xs text-muted-foreground">
                {t('page', { page: f.number(cursors.length + 1) })}
              </span>
              <Button
                variant="secondary"
                disabled={!data.nextCursor}
                onClick={() => data.nextCursor && next(data.nextCursor)}
              >
                {t('more')} <ChevronRight className="rtl:-scale-x-100" />
              </Button>
            </nav>
          )}
        </div>
      </section>
    </>
  );
}
