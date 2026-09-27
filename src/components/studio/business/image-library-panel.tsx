'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ImageIcon, Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, useApi } from '@/lib/client/api';
import type { Page } from '@/lib/client/types';
import { EmptyState, ErrorState } from '../primitives';
import { NativeSelect } from '../publications/native-select';
import { ImageGrid, SOURCE_LABEL } from './image-grid';
import {
  GenerateImageButton,
  RefreshLibraryButton,
  UploadImageButton,
} from './image-library-actions';
import type { ImageSource, LibraryImage } from './types';

// A6.8 — the per-business image library: browse by source/tag (GET, cursor pages), semantic
// search (POST /image-library/search), upload, generate, refresh stock, delete.

const SOURCES = Object.keys(SOURCE_LABEL) as ImageSource[];

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
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">
          {results.length} {results.length === 1 ? 'image' : 'images'} like{' '}
          <span className="font-medium">“{query}”</span>
        </p>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> Clear search
        </Button>
      </div>
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No close matches. Images are searchable once their embedding is computed.
        </p>
      ) : (
        <ImageGrid images={results} onDelete={onDelete} label="Search results" />
      )}
    </div>
  );
}

export function ImageLibraryPanel({ businessId }: { businessId: string }) {
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
      toast.success('Image deleted');
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
            Search images by meaning
          </Label>
          <Input
            id="library-search"
            placeholder="Search: “cosy bakery interior”"
            maxLength={500}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={!queryInput.trim() || searching}>
            {searching ? <Loader2 className="animate-spin" /> : <Search />}
            <span className="sr-only sm:not-sr-only">Search</span>
          </Button>
        </form>
        <div className="flex flex-wrap gap-1">
          <UploadImageButton businessId={businessId} onAdded={added} />
          <GenerateImageButton businessId={businessId} onAdded={added} />
          <RefreshLibraryButton businessId={businessId} />
        </div>
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
              Source
            </Label>
            <NativeSelect
              id="library-source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setCursors([]);
              }}
            >
              <option value="">All sources</option>
              {SOURCES.map((s) => (
                <option key={s} value={s.toLowerCase()}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
            <Label htmlFor="library-tag" className="ml-2 text-xs text-muted-foreground">
              Tag
            </Label>
            <Input
              id="library-tag"
              className="w-36"
              maxLength={60}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <Button type="submit" variant="ghost" size="sm">
              Apply
            </Button>
          </form>
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && (
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
              aria-label="Loading images"
            >
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          )}
          {data && data.data.length === 0 && (
            <EmptyState
              icon={<ImageIcon className="size-8" strokeWidth={1.5} />}
              title={filtered ? 'No images match' : 'Your image library is empty'}
              description={
                filtered
                  ? 'Try another source or tag.'
                  : 'Scan your website to fill it automatically, or upload and generate images.'
              }
            />
          )}
          {data && data.data.length > 0 && (
            <>
              <ImageGrid images={data.data} onDelete={remove} label="Image library" />
              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  disabled={cursors.length === 0}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  Newer
                </Button>
                <Button
                  variant="ghost"
                  disabled={!data.nextCursor}
                  onClick={() =>
                    data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])
                  }
                >
                  Older
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
