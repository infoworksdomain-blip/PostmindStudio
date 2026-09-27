'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Clapperboard, Layers, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import {
  formatPence,
  PLATFORM_LABEL,
  PROJECT_STATE,
  relativeTime,
  stateOf,
} from '@/lib/client/format';
import type { Page, Project } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';

// BACKLOG 10.5 — Manage: projects list, filtered by state (spec 14.3), cursor pagination.

export const PROJECT_FILTERS: Array<{ key: string; label: string; states?: string }> = [
  { key: 'all', label: 'All' },
  {
    key: 'working',
    label: 'In progress',
    states:
      'QUEUED,SCANNING,PLANNING,ASSETS_QUEUED,ASSETS_GENERATING,RENDERING,QUALITY_CHECKING,PUBLISHING',
  },
  { key: 'review', label: 'To review', states: 'READY_FOR_REVIEW,QUALITY_FAILED' },
  { key: 'draft', label: 'Drafts', states: 'DRAFT' },
  { key: 'published', label: 'Published', states: 'PUBLISHED,PARTIALLY_PUBLISHED,APPROVED' },
  { key: 'failed', label: 'Failed', states: 'FAILED,REJECTED' },
];

const SOURCE_ICON: Record<string, typeof Clapperboard> = {
  SLIDESHOW: Layers,
  LIBRARY_REFERENCE: Sparkles,
};

function ProjectRow({ project }: { project: Project }) {
  const state = stateOf(PROJECT_STATE, project.state);
  const Icon = SOURCE_ICON[project.sourceType] ?? Clapperboard;
  const platforms = (project.targetFormats ?? []).map(
    (f) => PLATFORM_LABEL[f.platform] ?? f.platform,
  );
  return (
    <li>
      <Link
        href={`/projects/${project.id}`}
        className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-xl border border-transparent px-4 py-4 transition-colors hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:grid-cols-[auto_1fr_10rem_7rem_auto]"
      >
        <span className="grid size-10 place-items-center rounded-lg bg-secondary text-muted-foreground">
          <Icon className="size-5" strokeWidth={1.5} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{project.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {platforms.join(' · ') || 'No formats'} — updated {relativeTime(project.updatedAt)}
          </span>
        </span>
        <span className="hidden md:block">
          <StateBadge {...state} />
        </span>
        <span className="tabular hidden text-right text-sm text-muted-foreground md:block">
          {formatPence(project.costActualPence)}
        </span>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

export function ProjectsList() {
  const [filter, setFilter] = useState('all');
  const [cursors, setCursors] = useState<string[]>([]);
  const states = PROJECT_FILTERS.find((f) => f.key === filter)?.states;
  const { data, error, isLoading, mutate } = useApi<Page<Project>>('/projects', {
    state: states,
    cursor: cursors.at(-1),
    limit: 20,
  });

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Projects"
        description="Every video, from first brief to published post."
        actions={
          <Button asChild>
            <Link href="/new">
              <Plus /> New video
            </Link>
          </Button>
        }
      />
      <div role="tablist" aria-label="Filter projects" className="mb-6 flex flex-wrap gap-1.5">
        {PROJECT_FILTERS.map((f) => (
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

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && (
        <div className="flex flex-col gap-2" aria-label="Loading projects">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-xl" />
          ))}
        </div>
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          title={filter === 'all' ? 'No videos yet' : 'Nothing here'}
          description={
            filter === 'all'
              ? 'Describe what the video is about and Studio writes, shoots and edits it.'
              : 'No projects match this filter.'
          }
          action={
            filter === 'all' && (
              <Button asChild>
                <Link href="/new">
                  <Plus /> Make your first video
                </Link>
              </Button>
            )
          }
        />
      )}
      {data && data.data.length > 0 && (
        <>
          <ul className="flex flex-col gap-1">
            {data.data.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
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
