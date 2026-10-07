'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, useApi, useErrorMessage } from '@/lib/client/api';
import type { Page } from '@/lib/client/types';
import { EmptyState, ErrorState } from '../primitives';
import { NativeSelect } from '@/components/ui/native-select';
import { IMAGE_SOURCES, ImageGrid } from './image-grid';
import {
  GenerateImageButton,
  RefreshLibraryButton,
  UploadImageButton,
} from './image-library-actions';
import { WriteGate } from '../write-gate';
import type { LibraryImage } from './types';

// A6.8 — the per-business image library: browse by source/tag (GET, cursor pages), semantic
// search (POST /image-library/search), upload, generate, refresh stock, delete.

function SearchResults({
  query,
  results,
  onClear,
  onDelete,
}: {
  query: string;
  results: LibraryImage[];
  onClear: () => void;
  onDelete: (image: LibraryImage) => Promise<boolean>;
}) {
  const t = useTranslations('business.images');
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">
          {t.rich('searchSummary', {
            count: results.length,
            query,
            term: (chunks) => <span className="font-medium">{chunks}</span>,
          })}
        </p>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> {t('clearSearch')}
        </Button>
      </div>
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMatches')}</p>
      ) : (
        <ImageGrid images={results} onDelete={onDelete} label={t('searchResultsAria')} />
      )}
    </div>
  );
}

export function ImageLibraryPanel({ businessId }: { businessId: string }) {
  const t = useTranslations('business.images');
  const errorMessage = useErrorMessage();
  const [source, setSource] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tag, setTag] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [queryInput, setQueryInput] = useState('');
  const [search, setSearch] = useState<{ query: string; results: LibraryImage[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const { data, error, isLoading, mutate } = useApi<Page<LibraryImage>>('/image-library', {
    businessId,
    source: source || undefined,
    tag: tag || undefined,
    cursor: cursors.at(-1),
    limit: 30,
  });

  async function runSearch() {
    const query = queryInput.trim();
    if (!query) return;
    setSearching(true);
    try {
      const res = await api<{ data: LibraryImage[] }>('/image-library/search', {
        method: 'POST',
        body: { businessId, query, limit: 24 },
      });
      setSearch({ query, results: res.data });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }

  async function remove(image: LibraryImage): Promise<boolean> {
    try {
      await api(`/image-library/${image.id}`, { method: 'DELETE' });
      toast.success(t('deleted'));
      setSearch((s) => s && { ...s, results: s.results.filter((r) => r.id !== image.id) });
      void mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  const added = () => {
    setCursors([]);
    void mutate();
  };
  const filtered = Boolean(source || tag);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form
          role="search"
          className="flex min-w-0 flex-1 gap-2 sm:max-w-md"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <Label htmlFor="library-search" className="sr-only">
            {t('searchLabel')}
          </Label>
          <Input
            id="library-search"
            placeholder={t('searchPlaceholder')}
            maxLength={500}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!queryInput.trim() || searching}>
            {searching ? <Loader2 className="animate-spin" /> : <Search />}
            <span className="sr-only sm:not-sr-only">{t('search')}</span>
          </Button>
        </form>
        <WriteGate>
          <div className="flex flex-wrap gap-1">
            <UploadImageButton businessId={businessId} onAdded={added} />
            <GenerateImageButton businessId={businessId} onAdded={added} />
            <RefreshLibraryButton businessId={businessId} />
          </div>
        </WriteGate>
      </div>

      {search ? (
        <SearchResults
          query={search.query}
          results={search.results}
          onClear={() => setSearch(null)}
          onDelete={remove}
        />
      ) : (
        <>
          <form
            className="flex flex-wrap items-center gap-2 border-y border-border/70 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              setTag(tagInput.trim());
              setCursors([]);
            }}
          >
            <Label htmlFor="library-source" className="text-xs text-muted-foreground">
              {t('source')}
            </Label>
            <NativeSelect
              wrapperClassName="w-auto"
              id="library-source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setCursors([]);
              }}
            >
              <option value="">{t('allSources')}</option>
              {IMAGE_SOURCES.map((s) => (
                <option key={s} value={s.toLowerCase()}>
                  {t(`sources.${s}`)}
                </option>
              ))}
            </NativeSelect>
            <Label htmlFor="library-tag" className="ms-2 text-xs text-muted-foreground">
              {t('tag')}
            </Label>
            <Input
              id="library-tag"
              className="w-36"
              maxLength={60}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <Button type="submit" variant="ghost" size="sm">
              {t('apply')}
            </Button>
          </form>
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && (
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
              aria-label={t('loading')}
            >
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          )}
          {data && data.data.length === 0 && (
            <EmptyState
              media="images"
              title={filtered ? t('emptyFiltered.title') : t('empty.title')}
              description={filtered ? t('emptyFiltered.body') : t('empty.body')}
            />
          )}
          {data && data.data.length > 0 && (
            <>
              <ImageGrid images={data.data} onDelete={remove} label={t('gridAria')} />
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  {t('newer')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!data.nextCursor}
                  onClick={() =>
                    data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])
                  }
                >
                  {t('older')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
