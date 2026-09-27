'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApi } from '@/lib/client/api';
import { formatDate, PLATFORM_LABEL, PUBLICATION_STATE, stateOf } from '@/lib/client/format';
import type { Page, Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { NativeSelect } from './native-select';
import { PublicationActions } from './publication-actions';

// BACKLOG 10.5 — Manage: every publication across platforms (spec 14.3), filtered by state and
// platform, cursor-paginated (GET /publications).

export const PUBLICATION_FILTERS: Array<{ key: string; label: string; states?: string }> = [
  { key: 'all', label: 'All' },
  { key: 'scheduled', label: 'Scheduled', states: 'SCHEDULED' },
  { key: 'live', label: 'Live', states: 'PUBLISHED,PUBLISHING' },
  { key: 'failed', label: 'Failed', states: 'FAILED' },
  { key: 'ended', label: 'Cancelled & taken down', states: 'CANCELLED,TAKEN_DOWN' },
];

/** The moment that matters for a row: when it went live, else when it is due, else created. */
export function whenOf(p: Publication): { label: string; iso: string } {
  if (p.publishedAt) return { label: 'Published', iso: p.publishedAt };
  if (p.scheduledFor) return { label: 'Scheduled for', iso: p.scheduledFor };
  return { label: 'Created', iso: p.createdAt };
}

function PublicationRow({ p, onChanged }: { p: Publication; onChanged: () => void }) {
  const state = stateOf(PUBLICATION_STATE, p.state);
  const platform = PLATFORM_LABEL[p.platform] ?? p.platform;
  const when = whenOf(p);
  return (
    <TableRow>
      <TableCell className="max-w-0 py-3 whitespace-normal md:w-[40%]">
        <Link
          href={`/projects/${p.projectId}`}
          className="block truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {p.project?.name ?? 'Untitled project'}
        </Link>
        <span className="block truncate text-xs text-muted-foreground md:hidden">
          {platform} · {when.label.toLowerCase()} {formatDate(when.iso)}
        </span>
        {p.state === 'FAILED' && p.errorReason && (
          <span className="mt-1 block text-xs text-destructive">{p.errorReason}</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell">{platform}</TableCell>
      <TableCell>
        <StateBadge {...state} />
      </TableCell>
      <TableCell className="tabular hidden text-muted-foreground md:table-cell">
        <span className="block text-xs">{when.label}</span>
        {formatDate(when.iso)}
      </TableCell>
      <TableCell className="text-right">
        <PublicationActions publication={p} onChanged={onChanged} />
      </TableCell>
    </TableRow>
  );
}

export function PublicationsList() {
  const [filter, setFilter] = useState('all');
  const [platform, setPlatform] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const states = PUBLICATION_FILTERS.find((f) => f.key === filter)?.states;
  const { data, error, isLoading, mutate } = useApi<Page<Publication>>('/publications', {
    state: states,
    platform: platform || undefined,
    cursor: cursors.at(-1),
    limit: 25,
  });

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Publications"
        description="Every post Studio has made or scheduled, on every platform."
        actions={
          <Button variant="outline" asChild>
            <Link href="/calendar">
              <CalendarDays /> Calendar
            </Link>
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter publications" className="flex flex-wrap gap-1.5">
          {PUBLICATION_FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setCursors([]);
              }}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                filter === f.key
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="publication-platform" className="text-xs text-muted-foreground">
            Platform
          </Label>
          <NativeSelect
            id="publication-platform"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">All platforms</option>
            {Object.entries(PLATFORM_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && (
        <div className="flex flex-col gap-2" aria-label="Loading publications">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          title={filter === 'all' && !platform ? 'Nothing published yet' : 'Nothing here'}
          description={
            filter === 'all' && !platform
              ? 'Approve a video on its review screen to publish or schedule it.'
              : 'No publications match these filters.'
          }
          action={
            filter === 'all' &&
            !platform && (
              <Button asChild>
                <Link href="/projects">Go to projects</Link>
              </Button>
            )
          }
        />
      )}
      {data && data.data.length > 0 && (
        <>
          <Table className="table-fixed md:table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>Video</TableHead>
                <TableHead className="hidden md:table-cell">Platform</TableHead>
                <TableHead className="w-28 md:w-auto">State</TableHead>
                <TableHead className="hidden md:table-cell">When</TableHead>
                <TableHead className="w-28 text-right md:w-auto">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((p) => (
                <PublicationRow key={p.id} p={p} onChanged={() => void mutate()} />
              ))}
            </TableBody>
          </Table>
          <div className="mt-6 flex justify-between">
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
  );
}
