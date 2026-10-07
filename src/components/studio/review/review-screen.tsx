'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ACTIVE_STATES, useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useProjectName } from '@/lib/client/use-project-name';
import { cn } from '@/lib/utils';
import { useShowCosts } from '../account/use-show-costs';
import { useBusiness } from '../business-context';
import { useLiveRefetch } from '../live/use-live-refetch';
import { ErrorState, PageHeader } from '../primitives';
import { attentionItems } from './attention-model';
import { ReviewPlayer } from './review-player';
import { ReviewStatus } from './review-status';
import { ReviewTabContent, tabKeysFor } from './review-tab-content';
import { ReviewTabs, TabPanel } from './review-tabs';
import { resolveTab, useTabParam } from './use-tab-param';

// BACKLOG 10.4 — Review (spec 14.2): one screen, all variants. 25.8: player first. On wide screens
// the chosen variant plays large on the left and the status & actions column sits beside it (one
// status line with the live stage and ETA, the pipeline, the next action, the actions menu, and
// one "Needs your attention" list); on phones the player comes first, then status, then the tabs.
// The active tab is in the URL (?tab=). Live events (24.2) refresh the project; without the
// stream it polls every POLL_MS while the pipeline is working.

export const POLL_MS = 4_000;

export { staleRenderIds } from './review-tab-content';

const SOURCES = [
  'BRIEF',
  'SLIDESHOW',
  'LIBRARY_REFERENCE',
  'POSTMIND_CONTENT',
  'TEMPLATE',
  'UPLOAD',
  'CAROUSEL',
  // 22.1 / 22.2: reviewed like any video (shots, overlays, renders, publish).
  'HOOK_DEMO',
  'WALL_OF_TEXT',
] as const;
type SourceKey = (typeof SOURCES)[number];
const isSource = (s: string): s is SourceKey => (SOURCES as readonly string[]).includes(s);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Scroll an element into view (instantly when motion is reduced) and focus it. */
function reveal(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
}

export function ReviewScreen({ projectId }: { projectId: string }) {
  const t = useTranslations('review.screen');
  const f = useFormat();
  const showCosts = useShowCosts();
  const projectName = useProjectName();
  const { businessId } = useBusiness();
  const liveOpen = useRef(false);
  const { data, error, isLoading, mutate } = useApi<{ project: ProjectDetail }>(
    `/projects/${projectId}`,
    undefined,
    {
      refreshInterval: (latest) =>
        latest && ACTIVE_STATES.has(latest.project.state) && !liveOpen.current ? POLL_MS : 0,
    },
  );
  const refresh = () => void mutate();
  const live = useLiveRefetch(projectId, refresh, liveOpen, (e) => e.projectId === projectId);
  const { requested, setTab } = useTabParam();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const playerRef = useRef<HTMLElement>(null);

  if (error)
    return (
      <>
        <BackLink />
        <ErrorState
          error={error}
          onRetry={refresh}
          notFound={{
            title: t('notFound.title'),
            body: t('notFound.body'),
            href: '/projects',
            action: t('notFound.action'),
          }}
        />
      </>
    );
  if (isLoading || !data)
    return (
      <div className="flex flex-col gap-4" aria-label={t('loading')}>
        <Skeleton className="h-16 rounded-xl" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );

  const { project } = data;
  const name = projectName(project.name);
  const keys = tabKeysFor(project);
  const defaultTab = keys[0] ?? 'variants';
  const active = resolveTab(requested, keys);
  const tabs = keys.map((key) => ({ key, label: t(`tabs.${key}`) }));
  const isCarousel = project.sourceType === 'CAROUSEL';
  const working = ACTIVE_STATES.has(project.state);
  const selected = project.renders.find((r) => r.id === selectedId) ?? project.renders[0] ?? null;
  // A carousel previews in its editor; a draft or a stopped run without a video has nothing to play.
  const hasPlayer = !isCarousel && (project.renders.length > 0 || working);
  const attention = attentionItems(project, { isCarousel });

  const openTab = (key: string) => setTab(key, defaultTab);
  const openPublish = () => {
    openTab('publish');
    requestAnimationFrame(() => reveal(document.getElementById('review-tab-publish')));
  };
  const showVariant = (renderId: string) => {
    setSelectedId(renderId);
    requestAnimationFrame(() => reveal(playerRef.current));
  };

  return (
    <>
      <BackLink />
      <PageHeader
        eyebrow={isSource(project.sourceType) ? t(`sources.${project.sourceType}`) : t('eyebrow')}
        title={name}
        description={
          showCosts ? (
            <span className="flex flex-wrap items-center gap-2">
              {/* Operator decision 2026-10-04: spend and budget are for platform staff only. */}
              <span className="tabular" data-testid="project-spent">
                {t('spent', { amount: f.pence(project.costActualPence) })}
              </span>
              {project.costBudgetPence !== null && (
                <span className="tabular">
                  {t('ofBudget', { amount: f.pence(project.costBudgetPence) })}
                </span>
              )}
            </span>
          ) : undefined
        }
      />
      <div
        data-layout={hasPlayer ? 'player' : 'status'}
        className={cn(
          'grid gap-8',
          hasPlayer ? 'lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start' : 'max-w-3xl',
        )}
      >
        {hasPlayer && (
          <ReviewPlayer
            ref={playerRef}
            renders={project.renders}
            selected={selected}
            onSelect={setSelectedId}
            working={working}
            placeholderAspect={project.targetFormats?.[0]?.aspectRatio ?? '9:16'}
          />
        )}
        <ReviewStatus
          project={project}
          selected={selected}
          live={live.statuses.get(project.id)}
          attention={attention}
          onChanged={refresh}
          onPublish={openPublish}
        />
      </div>
      <div className="mt-10">
        <ReviewTabs tabs={tabs} active={active} onChange={openTab} />
        <TabPanel tab={active}>
          <ReviewTabContent
            tab={active}
            project={project}
            businessId={businessId}
            selectedId={selected?.id ?? null}
            onShow={showVariant}
            onChanged={refresh}
          />
        </TabPanel>
      </div>
    </>
  );
}

function BackLink() {
  const t = useTranslations('review.screen');
  return (
    <Button asChild variant="ghost" size="sm" className="mb-4 -ms-2">
      <Link href="/projects">
        <ArrowLeft className="rtl:-scale-x-100" /> {t('back')}
      </Link>
    </Button>
  );
}
