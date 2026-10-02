'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Clapperboard,
  Copy,
  Layers,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, newIdempotencyKey, useApi, useErrorMessage } from '@/lib/client/api';
import { ACTIVE_STATES, useFormat } from '@/lib/client/format';
import type { Page, Project } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, PageHeader, StateBadge } from '../primitives';
import { FailureReason } from '../failure-reason';
import { DIRECTIONS_ANCHOR, needsDirection } from '../review/directions-panel';
import { ConfirmDialog } from '../publications/confirm-dialog';
import { useCan } from '../use-can';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 10.5 — Manage: projects list, filtered by state (spec 14.3), searched by name or brief,
// cursor pagination. The filter and the search live in the URL (?filter=review&q=bread) so a list
// can be shared and survives a reload. Each row can be duplicated, archived (hidden but kept,
// restorable) or deleted, for roles that may write projects.

export type ProjectFilterKey =
  'all' | 'working' | 'review' | 'draft' | 'published' | 'failed' | 'archived';

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
  { key: 'archived', states: 'ARCHIVED' },
];

/** How long typing pauses before the search is applied (and written to the URL). */
export const SEARCH_DEBOUNCE_MS = 300;

const SOURCE_ICON: Record<string, typeof Clapperboard> = {
  SLIDESHOW: Layers,
  LIBRARY_REFERENCE: Sparkles,
};

function isFilterKey(value: string | null | undefined): value is ProjectFilterKey {
  return PROJECT_FILTERS.some((pf) => pf.key === value);
}

/** The filter and search kept in the URL; changing either starts again from the first page. */
function useListUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rawFilter = params?.get('filter');
  const filter: ProjectFilterKey = isFilterKey(rawFilter) ? rawFilter : 'all';
  const q = params?.get('q') ?? '';
  const update = (next: { filter?: ProjectFilterKey; q?: string }) => {
    const search = new URLSearchParams(params?.toString() ?? '');
    const nextFilter = next.filter ?? filter;
    const nextQ = (next.q ?? q).trim();
    if (nextFilter === 'all') search.delete('filter');
    else search.set('filter', nextFilter);
    if (nextQ) search.set('q', nextQ);
    else search.delete('q');
    const qs = search.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  return { filter, q, update };
}

type RowAction = 'duplicate' | 'archive' | 'unarchive' | 'delete';

function RowMenu({
  project,
  name,
  onChanged,
}: {
  project: Project;
  name: string;
  onChanged: () => void;
}) {
  const t = useTranslations('projects.list.actions');
  const errorMessage = useErrorMessage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archived = project.state === 'ARCHIVED';
  // The API refuses to archive or delete a run in progress ("cancel generation first").
  const running = ACTIVE_STATES.has(project.state);

  async function run(action: RowAction): Promise<boolean> {
    try {
      if (action === 'delete') await api(`/projects/${project.id}`, { method: 'DELETE' });
      else
        await api(`/projects/${project.id}/${action}`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
        });
      toast.success(t(`done.${action}`));
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('menu', { name })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void run('duplicate')}>
            <Copy /> {t('duplicate')}
          </DropdownMenuItem>
          {archived ? (
            <DropdownMenuItem onSelect={() => void run('unarchive')}>
              <ArchiveRestore /> {t('unarchive')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled={running} onSelect={() => void run('archive')}>
              <Archive /> {t('archive')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={running}
            onSelect={() => setConfirmDelete(true)}
          >
            <Trash2 /> {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deleteConfirm.title')}
        description={t('deleteConfirm.body', { name })}
        confirmLabel={t('deleteConfirm.confirm')}
        onConfirm={() => run('delete')}
      />
    </>
  );
}

function ProjectRow({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const t = useTranslations('projects.list');
  const f = useFormat();
  const state = f.projectState(project.state);
  const Icon = SOURCE_ICON[project.sourceType] ?? Clapperboard;
  const platforms = (project.targetFormats ?? []).map((tf) => f.platform(tf.platform));
  const projectName = useProjectName();
  const name = projectName(project.name);
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  // 20.18: a brief too vague to plan opens straight on the "choose a direction" panel.
  const vague = needsDirection(project);
  return (
    <li className="flex items-center gap-1 rounded-xl border border-transparent pe-2 transition-colors hover:border-border hover:bg-card">
      <Link
        href={`/projects/${project.id}${vague ? `#${DIRECTIONS_ANCHOR}` : ''}`}
        className="group grid min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-4 rounded-xl px-4 py-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:grid-cols-[auto_1fr_10rem_7rem_auto]"
      >
        <span className="grid size-10 place-items-center rounded-lg bg-secondary text-muted-foreground">
          <Icon className="size-5" strokeWidth={1.5} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t('rowMeta', {
              platforms: platforms.join(' · ') || t('noFormats'),
              updated: f.relative(project.updatedAt),
            })}
          </span>
          {vague && (
            <span
              data-testid="project-row-reason"
              className="block truncate text-xs text-amber-700 dark:text-amber-400"
            >
              <FailureReason reason={project.errorReason} />
            </span>
          )}
        </span>
        <span className="hidden md:block">
          <StateBadge {...state} />
        </span>
        <span className="tabular hidden text-end text-sm text-muted-foreground md:block">
          {f.pence(project.costActualPence)}
        </span>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
      </Link>
      {mayWrite && <RowMenu project={project} name={name} onChanged={onChanged} />}
    </li>
  );
}

function SearchBox({ value, onApply }: { value: string; onApply: (q: string) => void }) {
  const t = useTranslations('projects.list.search');
  const [text, setText] = useState(value);
  const applied = useRef(value);
  // A change from outside (back button, a shared link) replaces what is typed.
  useEffect(() => {
    applied.current = value;
    setText(value);
  }, [value]);
  useEffect(() => {
    if (text.trim() === applied.current.trim()) return;
    const timer = setTimeout(() => {
      applied.current = text;
      onApply(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, onApply]);
  return (
    <div className="relative mb-4 max-w-md">
      <Search
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={text}
        maxLength={200}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        onChange={(e) => setText(e.target.value)}
        className="ps-9"
      />
    </div>
  );
}

export function ProjectsList() {
  const t = useTranslations('projects.list');
  const tn = useTranslations('shell.nav.groups');
  const { filter, q, update } = useListUrlState();
  const [cursors, setCursors] = useState<string[]>([]);
  const states = PROJECT_FILTERS.find((pf) => pf.key === filter)?.states;
  const { data, error, isLoading, mutate } = useApi<Page<Project>>('/projects', {
    state: states,
    q: q || undefined,
    cursor: cursors.at(-1),
    limit: 20,
  });
  // Filter or search changed (also from the URL): back to the first page.
  // A row action changes what every filter / search shows (a project leaves All, enters Archived):
  // refresh every cached list, not just the one on screen (SWR would otherwise serve a list
  // fetched just before the action when the user switches filter within its dedupe window).
  const { mutate: mutateAny } = useSWRConfig();
  const refreshLists = () =>
    void mutateAny((key) => typeof key === 'string' && key.includes('/projects?'));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else setCursors([]);
  }, [filter, q]);

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
      <SearchBox value={q} onApply={(next) => update({ q: next })} />
      <div role="tablist" aria-label={t('filtersAria')} className="mb-6 flex flex-wrap gap-1.5">
        {PROJECT_FILTERS.map((pf) => (
          <button
            key={pf.key}
            role="tab"
            aria-selected={filter === pf.key}
            onClick={() => update({ filter: pf.key })}
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
          title={
            q
              ? t('emptySearch.title')
              : filter === 'all'
                ? t('empty.title')
                : t('emptyFiltered.title')
          }
          description={
            q
              ? t('emptySearch.body', { query: q })
              : filter === 'all'
                ? t('empty.body')
                : t('emptyFiltered.body')
          }
          action={
            filter === 'all' &&
            !q && (
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
              <ProjectRow key={p.id} project={p} onChanged={refreshLists} />
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
