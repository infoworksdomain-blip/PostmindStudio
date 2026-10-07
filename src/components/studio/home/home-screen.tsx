'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  CalendarRange,
  Layers,
  LayoutTemplate,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Page, Project, Publication } from '@/lib/client/types';
import { useProjectName } from '@/lib/client/use-project-name';
import { cn } from '@/lib/utils';
import { idsKey } from '../live/live-model';
import { StatusChip } from '../live/status-chip';
import { FALLBACK_POLL_MS } from '../live/use-live-projects';
import { useLiveRefetch } from '../live/use-live-refetch';
import { ErrorState, PageHeader } from '../primitives';

// BACKLOG 25.4 — the signed-in home (/home). Every section reads an API the app already has:
//   Needs you   — GET /projects?state=READY_FOR_REVIEW,QUALITY_FAILED (the Projects "review"
//                 filter) and GET /publications?state=FAILED;
//   Coming up   — GET /publications?state=SCHEDULED&from=now&to=now+7d (the calendar's read);
//   In progress — GET /projects?state=<working states> with the 24.2 live status chip.
// Plus the create entry points and the month planner. Nothing here is invented: an empty section
// says so and points at the page that would fill it.

/** The Projects list's "review" and "working" filters (projects-list.tsx PROJECT_FILTERS). */
export const REVIEW_STATES = 'READY_FOR_REVIEW,QUALITY_FAILED';
export const WORKING_STATES =
  'QUEUED,SCANNING,PLANNING,ASSETS_QUEUED,ASSETS_GENERATING,RENDERING,QUALITY_CHECKING,PUBLISHING';

const DAY_MS = 86_400_000;
const LIST_LIMIT = 5;
const COMING_UP_DAYS = 7;

function Section({
  id,
  title,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn('grid content-start gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-control text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
      <ArrowRight aria-hidden className="size-3 rtl:-scale-x-100" />
    </Link>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-field border border-border bg-card">
      {children}
    </ul>
  );
}

function Row({
  href,
  title,
  meta,
  status,
}: {
  href: string;
  title: string;
  meta?: string;
  status: ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
      >
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
        </span>
        {status}
      </Link>
    </li>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-field border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Loading() {
  return (
    <div className="grid gap-2" aria-hidden>
      <Skeleton className="h-14 w-full rounded-field" />
      <Skeleton className="h-14 w-full rounded-field" />
    </div>
  );
}

function NeedsYou() {
  const t = useTranslations('home.needsYou');
  const f = useFormat();
  const projectName = useProjectName();
  const review = useApi<Page<Project>>('/projects', { state: REVIEW_STATES, limit: LIST_LIMIT });
  const failed = useApi<Page<Publication>>('/publications', { state: 'FAILED', limit: LIST_LIMIT });
  const error = review.error ?? failed.error;
  const loading = review.isLoading || failed.isLoading;
  const projects = review.data?.data ?? [];
  const posts = failed.data?.data ?? [];
  return (
    <Section id="home-needs-you" title={t('title')}>
      {error ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void review.mutate();
            void failed.mutate();
          }}
        />
      ) : loading ? (
        <Loading />
      ) : projects.length + posts.length === 0 ? (
        <Quiet>{t('empty')}</Quiet>
      ) : (
        <Rows>
          {projects.map((p) => {
            const state = f.projectState(p.state);
            return (
              <Row
                key={p.id}
                href={`/projects/${p.id}`}
                title={projectName(p.name)}
                meta={t('reviewMeta', { when: f.relative(p.createdAt) })}
                status={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
              />
            );
          })}
          {posts.map((p) => {
            const state = f.publicationState(p.state);
            return (
              <Row
                key={p.id}
                href="/publications"
                title={projectName(p.project?.name)}
                meta={t('failedMeta', { platform: f.platform(p.platform) })}
                status={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
              />
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

function ComingUp() {
  const t = useTranslations('home.comingUp');
  const f = useFormat();
  const projectName = useProjectName();
  // The window is fixed when the screen opens, so the request (and its cache key) stays stable.
  const [window_] = useState(() => {
    const now = Date.now();
    return {
      from: new Date(now).toISOString(),
      to: new Date(now + COMING_UP_DAYS * DAY_MS).toISOString(),
    };
  });
  const { data, error, isLoading, mutate } = useApi<Page<Publication>>('/publications', {
    state: 'SCHEDULED',
    from: window_.from,
    to: window_.to,
    limit: 50,
  });
  const upcoming = useMemo(
    () =>
      [...(data?.data ?? [])]
        .filter((p) => p.scheduledFor)
        .sort((a, b) => Date.parse(a.scheduledFor ?? '') - Date.parse(b.scheduledFor ?? ''))
        .slice(0, 6),
    [data],
  );
  return (
    <Section
      id="home-coming-up"
      title={t('title')}
      action={<SectionLink href="/calendar">{t('calendar')}</SectionLink>}
    >
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading ? (
        <Loading />
      ) : upcoming.length === 0 ? (
        <Quiet>{t('empty')}</Quiet>
      ) : (
        <Rows>
          {upcoming.map((p) => (
            <Row
              key={p.id}
              href="/calendar"
              title={projectName(p.project?.name)}
              meta={f.platform(p.platform)}
              status={
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {f.date(p.scheduledFor, {
                    weekday: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}

function InProgress() {
  const t = useTranslations('home.inProgress');
  const f = useFormat();
  const projectName = useProjectName();
  const liveOpen = useRef(false);
  const { data, error, isLoading, mutate } = useApi<Page<Project>>(
    '/projects',
    { state: WORKING_STATES, limit: 6 },
    {
      // 24.2: while the live stream is open nothing polls; otherwise refresh while work runs.
      refreshInterval: (latest) =>
        latest && latest.data.length > 0 && !liveOpen.current ? FALLBACK_POLL_MS : 0,
    },
  );
  const projects = data?.data ?? [];
  const live = useLiveRefetch(idsKey(projects.map((p) => p.id)), () => void mutate(), liveOpen);
  return (
    <Section
      id="home-in-progress"
      title={t('title')}
      action={<SectionLink href="/projects?filter=working">{t('all')}</SectionLink>}
    >
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : isLoading ? (
        <Loading />
      ) : projects.length === 0 ? (
        <Quiet>{t('empty')}</Quiet>
      ) : (
        <Rows>
          {projects.map((p) => (
            <Row
              key={p.id}
              href={`/projects/${p.id}`}
              title={projectName(p.name)}
              meta={t('startedMeta', { when: f.relative(p.createdAt) })}
              status={<StatusChip live={live.statuses.get(p.id)} projectState={p.state} />}
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
  body,
  primary = false,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  body: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group grid gap-1 rounded-field border p-4 transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        primary
          ? 'border-primary/30 bg-signal-soft hover:border-primary/50'
          : 'border-border bg-card hover:bg-surface-raised',
      )}
    >
      <Icon
        aria-hidden
        className={cn('mb-2 size-5', primary ? 'text-primary' : 'text-muted-foreground')}
        strokeWidth={1.75}
      />
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{body}</span>
    </Link>
  );
}

function QuickCreate() {
  const t = useTranslations('home.quick');
  return (
    <section aria-labelledby="home-quick" className="grid gap-3">
      <h2 id="home-quick" className="sr-only">
        {t('title')}
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <QuickAction href="/new" icon={Plus} title={t('create')} body={t('createBody')} primary />
        <QuickAction
          href="/plans/new"
          icon={CalendarRange}
          title={t('plan')}
          body={t('planBody')}
        />
        <QuickAction href="/blitz" icon={Layers} title={t('blitz')} body={t('blitzBody')} />
        <QuickAction
          href="/templates"
          icon={LayoutTemplate}
          title={t('templates')}
          body={t('templatesBody')}
        />
      </div>
    </section>
  );
}

export function HomeScreen() {
  const t = useTranslations('home');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={<SectionLink href="/plans">{t('monthPlans')}</SectionLink>}
      />
      <div className="grid gap-10">
        <QuickCreate />
        <div className="grid gap-10 lg:grid-cols-2">
          <NeedsYou />
          <ComingUp />
        </div>
        <InProgress />
      </div>
    </>
  );
}
