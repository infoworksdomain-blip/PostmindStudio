'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage, newIdempotencyKey, useApi } from '@/lib/client/api';
import { formatDuration, relativeTime } from '@/lib/client/format';
import { ErrorState, Section, StateBadge } from '../primitives';
import { flattenCategories } from '../library/library-utils';
import type { CategoryNode, ListResponse } from '../library/types';
import { IngestForm } from './ingest-form';
import { IngestStatus } from './ingest-status';
import { LibraryEditDialog } from './library-edit-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { LibraryAdminFilterBar } from './library-admin-filters';
import { LibraryBulkBar } from './library-bulk-bar';
import { LicenceAudit } from './licence-audit';
import {
  DEFAULT_FILTERS,
  LICENCE_BADGE,
  REVIEW_LABEL,
  type AdminLibraryFilters,
  type AdminLibraryVideo,
} from './library-admin-types';

// A3.8 Library admin — bulk import, ingestion status, the licence audit, then the whole corpus
// from the staff list (GET /admin/library/videos, 15.D7): unlicensed and retired rows included,
// filterable by licence status and categorisation review, with bulk accept / override / reject
// and re-analysis, plus per-item edit and retire.

const PAGE_SIZE = 25;

function CorpusRow({
  video,
  selected,
  onSelect,
  onEdit,
  onRetire,
}: {
  video: AdminLibraryVideo;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onEdit: () => void;
  onRetire: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <Checkbox
        checked={selected}
        onCheckedChange={(v) => onSelect(v === true)}
        aria-label={`Select ${video.title}`}
      />
      <div className="min-w-0 flex-1 basis-60">
        <Link
          href={`/library/${video.id}`}
          className="block truncate text-sm font-medium hover:underline"
        >
          {video.title}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {video.category.slug} · {formatDuration(video.durationSec)}
          {video.licence.scenario && ` · ${video.licence.scenario}`}
          {video.categoryReview && ` · ${REVIEW_LABEL[video.categoryReview]}`}
          {video.reanalysedAt && ` · re-analysed ${relativeTime(video.reanalysedAt)}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {video.retiredAt && <StateBadge label="Retired" tone="neutral" />}
        <StateBadge {...LICENCE_BADGE[video.licence.status]} />
        <Button size="sm" variant="outline" onClick={onEdit}>
          Edit<span className="sr-only"> {video.title}</span>
        </Button>
        {!video.retiredAt && (
          <Button size="sm" variant="destructive" onClick={onRetire}>
            Retire<span className="sr-only"> {video.title}</span>
          </Button>
        )}
      </div>
    </li>
  );
}

export function LibraryAdminPanel() {
  const [filters, setFilters] = useState<AdminLibraryFilters>(DEFAULT_FILTERS);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<AdminLibraryVideo | null>(null);
  const [retiring, setRetiring] = useState<AdminLibraryVideo | null>(null);
  const tree = useApi<ListResponse<CategoryNode>>('/library/categories');
  const categories = useMemo(() => flattenCategories(tree.data?.data ?? []), [tree.data]);
  const { data, error, isLoading, mutate } = useApi<ListResponse<AdminLibraryVideo>>(
    '/admin/library/videos',
    {
      licence: filters.licence || undefined,
      retired: filters.retired || undefined,
      review: filters.review || undefined,
      category: filters.category || undefined,
      q: filters.q || undefined,
      cursor: cursors.at(-1),
      limit: PAGE_SIZE,
    },
  );
  const audit = useApi('/admin/library/licence-audit', { limit: 20 });

  const applyFilters = useCallback((next: AdminLibraryFilters) => {
    setFilters(next);
    setCursors([]);
    setSelected(new Set());
  }, []);
  const refresh = () => {
    setSelected(new Set());
    void mutate();
    void audit.mutate();
  };
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const pageIds = data?.data.map((v) => v.id) ?? [];
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const retire = async (video: AdminLibraryVideo) => {
    try {
      await api(`/admin/library/videos/${video.id}/retire`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`“${video.title}” retired`);
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <div className="grid gap-6">
      <IngestForm categories={categories} />
      <IngestStatus />
      <LicenceAudit
        onShowMissing={() => applyFilters({ ...DEFAULT_FILTERS, licence: 'missing' })}
      />
      <Section
        title="Corpus"
        description="Every item, including unlicensed and retired ones. Retired items are hidden from users but kept for projects that used them."
      >
        <div className="grid gap-4">
          <LibraryAdminFilterBar
            filters={filters}
            categories={categories}
            onChange={applyFilters}
          />
          {selected.size > 0 && (
            <LibraryBulkBar ids={[...selected]} categories={categories} onDone={refresh} />
          )}
          {error && <ErrorState error={error} onRetry={() => void mutate()} />}
          {isLoading && <Skeleton aria-label="Loading corpus" className="h-48 rounded-lg" />}
          {data && data.data.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">No items match these filters.</p>
          )}
          {data && data.data.length > 0 && (
            <div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set([...selected, ...pageIds]) : new Set())
                  }
                  aria-label="Select all on this page"
                />
                Select page
              </label>
              <ul aria-label="Corpus items" className="divide-y divide-border/70">
                {data.data.map((v) => (
                  <CorpusRow
                    key={v.id}
                    video={v}
                    selected={selected.has(v.id)}
                    onSelect={(on) => toggle(v.id, on)}
                    onEdit={() => setEditing(v)}
                    onRetire={() => setRetiring(v)}
                  />
                ))}
              </ul>
            </div>
          )}
          {data && (cursors.length > 0 || data.nextCursor) && (
            <div className="flex justify-between">
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
        </div>
      </Section>
      {editing && (
        <LibraryEditDialog
          video={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={refresh}
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
