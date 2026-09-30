'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Clapperboard, Layers, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Page, Project } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 10.5 — Manage: projects list, filtered by state (spec 14.3), cursor pagination.

export type ProjectFilterKey = 'all' | 'working' | 'review' | 'draft' | 'published' | 'failed';

export const PROJECT_FILTERS: Array<{ key: ProjectFilterKey; states?: string }> = [
  { key: 'all' },
  {
    key: 'working',
    states:
      'QUEUED,SCANNING,PLANNING,ASSETS_QUEUED,ASSETS_GENERATING,RENDERING,QUALITY_CHECKING,PUBLISHING',
  },
  { key: 'review', states: 'READY_FOR_REVIEW,QUALITY_FAILED' },
  { key: 'draft', states: 'DRAFT' },
  { key: 'published', states: 'PUBLISHED,PARTIALLY_PUBLISHED,APPROVED' },
  { key: 'failed', states: 'FAILED,REJECTED' },
];

const SOURCE_ICON: Record<string, typeof Clapperboard> = {
  SLIDESHOW: Layers,
  LIBRARY_REFERENCE: Sparkles,
};

function ProjectRow({ project }: { project: Project }) {
  const t = useTranslations('projects.list');
  const f = useFormat();
  const state = f.projectState(project.state);
  const Icon = SOURCE_ICON[project.sourceType] ?? Clapperboard;
  const platforms = (project.targetFormats ?? []).map((tf) => f.platform(tf.platform));
  const projectName = useProjectName();
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
          <span className="block truncate font-medium">{projectName(project.name)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t('rowMeta', {
              platforms: platforms.join(' · ') || t('noFormats'),
              updated: f.relative(project.updatedAt),
            })}
          </span>
        </span>
        <span className="hidden md:block">
          <StateBadge {...state} />
        </span>
        <span className="tabular hidden text-end text-sm text-muted-foreground md:block">
          {f.pence(project.costActualPence)}
        </span>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
      </Link>
    </li>
  );
}

export function ProjectsList() {
  const t = useTranslations('projects.list');
  const tn = useTranslations('shell.nav.groups');
  const [filter, setFilter] = useState<ProjectFilterKey>('all');
  const [cursors, setCursors] = useState<string[]>([]);
  const states = PROJECT_FILTERS.find((pf) => pf.key === filter)?.states;
  const { data, error, isLoading, mutate } = useApi<Page<Project>>('/projects', {
    state: states,
    cursor: cursors.at(-1),
    limit: 20,
  });

  return (
    <>
      <PageHeader
        eyebrow={tn('manage')}
        title={t('title')}
        description={t('description')}
        actions={
          <Button asChild>
            <Link href="/new">
              <Plus /> {t('newVideo')}
            </Link>
          </Button>
        }
      />
      <div role="tablist" aria-label={t('filtersAria')} className="mb-6 flex flex-wrap gap-1.5">
        {PROJECT_FILTERS.map((pf) => (
          <button
            key={pf.key}
            role="tab"
            aria-selected={filter === pf.key}
            onClick={() => {
              setFilter(pf.key);
              setCursors([]);
            }}
            className={cn(
              'rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              filter === pf.key
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground',
            )}
          >
            {t(`filters.${pf.key}`)}
          </button>
        ))}
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && (
        <div className="flex flex-col gap-2" aria-label={t('loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-xl" />
          ))}
        </div>
      )}
      {data && data.data.length === 0 && (
        <EmptyState
          illustration="projects"
          title={filter === 'all' ? t('empty.title') : t('emptyFiltered.title')}
          description={filter === 'all' ? t('empty.body') : t('emptyFiltered.body')}
          action={
            filter === 'all' && (
              <Button asChild>
                <Link href="/new">
                  <Plus /> {t('empty.action')}
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
  );
}
