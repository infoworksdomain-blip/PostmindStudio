'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDuration } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { selectClass } from '../library/library-filters';
import { flattenCategories } from '../library/library-utils';
import type { CategoryNode, LibraryVideoSummary, ListResponse } from '../library/types';
import { IngestForm } from './ingest-form';
import { LibraryEditDialog } from './library-edit-dialog';
import { ConfirmDialog } from './confirm-dialog';

// A3.8 Library admin — bulk import, then browse live corpus items by category to edit
// metadata/licence or retire them. The browse uses the user-facing list endpoint, so retired
// items and licence-less items can't be listed here (no staff list endpoint exists yet).

const PAGE_SIZE = 25;

export function LibraryAdminPanel() {
  const [category, setCategory] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [editing, setEditing] = useState<LibraryVideoSummary | null>(null);
  const [retiring, setRetiring] = useState<LibraryVideoSummary | null>(null);
  const tree = useApi<ListResponse<CategoryNode>>('/library/categories');
  const categories = useMemo(() => flattenCategories(tree.data?.data ?? []), [tree.data]);
  const { data, error, isLoading, mutate } = useApi<ListResponse<LibraryVideoSummary>>(
    '/library/videos',
    { category: category || undefined, cursor: cursors.at(-1), limit: PAGE_SIZE },
  );

  const retire = async (video: LibraryVideoSummary) => {
    try {
      await api(`/admin/library/videos/${video.id}/retire`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`“${video.title}” retired`);
      await mutate();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <div className="grid gap-6">
      <IngestForm categories={categories} />
      <Section
        title="Live corpus"
        description="Retired items are hidden from search but kept for projects that used them."
        actions={
          <div className="w-56 max-w-full">
            <label htmlFor="admin-library-category" className="sr-only">
              Category
            </label>
            <select
              id="admin-library-category"
              className={selectClass}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setCursors([]);
              }}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {`${'  '.repeat(c.depth)}${c.label}`}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {error && <ErrorState error={error} onRetry={() => void mutate()} />}
        {isLoading && <Skeleton aria-label="Loading corpus" className="h-48 rounded-lg" />}
        {data && data.data.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">No live items in this category.</p>
        )}
        {data && data.data.length > 0 && (
          <ul aria-label="Corpus items" className="divide-y divide-border/70">
            {data.data.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="min-w-0 flex-1 basis-60">
                  <Link
                    href={`/library/${v.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {v.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {v.category.slug} · {formatDuration(v.durationSec)} ·{' '}
                    {v.allowedModes.length ? v.allowedModes.join(' + ') : 'No licence row'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(v)}>
                    Edit<span className="sr-only"> {v.title}</span>
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setRetiring(v)}>
                    Retire<span className="sr-only"> {v.title}</span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && (cursors.length > 0 || data.nextCursor) && (
          <div className="mt-4 flex justify-between">
            <Button
              variant="ghost"
              disabled={cursors.length === 0}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              disabled={!data.nextCursor}
              onClick={() =>
                data.nextCursor && setCursors((c) => [...c, data.nextCursor as string])
              }
            >
              Next
            </Button>
          </div>
        )}
      </Section>
      {editing && (
        <LibraryEditDialog
          video={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => void mutate()}
        />
      )}
      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => !open && setRetiring(null)}
        title={`Retire “${retiring?.title ?? ''}”?`}
        description="It disappears from browse, search and recommendations. Projects that already used it keep working."
        confirmLabel="Retire"
        onConfirm={() => (retiring ? retire(retiring) : Promise.resolve(false))}
      />
    </div>
  );
}
