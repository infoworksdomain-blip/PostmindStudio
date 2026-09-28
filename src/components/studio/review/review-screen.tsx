'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ACTIVE_STATES, useFormat } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useBusiness } from '../business-context';
import { FailureReason } from '../failure-reason';
import { ErrorState, PageHeader, Section, StateBadge } from '../primitives';
import { OverlayEditor } from '../overlays/overlay-editor';
import { SlideshowBuilder } from '../slideshow/slideshow-builder';
import { AutomationPanel } from './automation-panel';
import { MusicStatus } from './music-status';
import { SfxStatus } from './sfx-status';
import { PipelineStrip } from './pipeline-strip';
import { ApprovalBar, ProjectActions } from './project-actions';
import { ApprovalStepIndicator } from '../approvals/approval-step-indicator';
import { PublicationsList } from './publications-list';
import { PublishPanel } from './publish-panel';
import { ShareLinksPanel } from '../share/share-links-panel';
import { ReviewTabs, TabPanel, type TabDef } from './review-tabs';
import { ScriptView } from './script-view';
import { ShotsTab } from './shots-tab';
import { PUBLISHABLE } from './types';
import { VariantCard } from './variant-card';
import { BudgetRaise, isProjectBudgetPause } from './budget-raise';
import { AutoResumeNote, FallbackNote, SafetyReviewNote } from './paused-notes';
import { useProjectName } from '@/lib/client/use-project-name';

// BACKLOG 10.4 — Review (spec 14.2): one screen, all variants. Polls every 4 s while the
// pipeline is working so progress, shots and renders update in place.

export const POLL_MS = 4_000;

const SOURCES = [
  'BRIEF',
  'SLIDESHOW',
  'LIBRARY_REFERENCE',
  'POSTMIND_CONTENT',
  'TEMPLATE',
  'UPLOAD',
] as const;
type SourceKey = (typeof SOURCES)[number];
const isSource = (s: string): s is SourceKey => (SOURCES as readonly string[]).includes(s);

const TAB_KEYS = ['slides', 'variants', 'shots', 'overlays', 'script', 'publish'] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** 13.1 / 13.2: renders made before the latest script or shot edits. */
export function staleRenderIds(project: ProjectDetail): Set<string> {
  const list = project.metadata?.staleRenders;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
}

function tabsFor(project: ProjectDetail, label: (key: TabKey) => string): TabDef[] {
  return TAB_KEYS.filter((key) => key !== 'slides' || project.sourceType === 'SLIDESHOW').map(
    (key) => ({ key, label: label(key) }),
  );
}

export function ReviewScreen({ projectId }: { projectId: string }) {
  const t = useTranslations('review.screen');
  const f = useFormat();
  const projectName = useProjectName();
  const { businessId } = useBusiness();
  const { data, error, isLoading, mutate } = useApi<{ project: ProjectDetail }>(
    `/projects/${projectId}`,
    undefined,
    {
      refreshInterval: (latest) =>
        latest && ACTIVE_STATES.has(latest.project.state) ? POLL_MS : 0,
    },
  );
  const [tab, setTab] = useState<string | null>(null);
  const refresh = () => void mutate();

  if (error)
    return (
      <>
        <BackLink />
        <ErrorState error={error} onRetry={refresh} />
      </>
    );
  if (isLoading || !data)
    return (
      <div className="flex flex-col gap-4" aria-label={t('loading')}>
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );

  const { project } = data;
  const tabs = tabsFor(project, (key) => t(`tabs.${key}`));
  const active = tab && tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? 'variants');
  const state = f.projectState(project.state);
  const working = ACTIVE_STATES.has(project.state);

  return (
    <>
      <BackLink />
      <PageHeader
        eyebrow={isSource(project.sourceType) ? t(`sources.${project.sourceType}`) : t('eyebrow')}
        title={projectName(project.name)}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge {...state} />
            <span className="tabular">
              {t('spent', { amount: f.pence(project.costActualPence) })}
            </span>
            {project.costBudgetPence !== null && (
              <span className="tabular">
                {t('ofBudget', { amount: f.pence(project.costBudgetPence) })}
              </span>
            )}
          </span>
        }
        actions={<ProjectActions project={project} onChanged={refresh} />}
      />
      <div className="flex flex-col gap-6">
        <PipelineStrip state={project.state} />
        {project.errorReason &&
          ['FAILED', 'REJECTED', 'QUALITY_FAILED'].includes(project.state) && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
            >
              <FailureReason reason={project.errorReason} />
            </p>
          )}
        {isProjectBudgetPause(project) && <BudgetRaise project={project} onChanged={refresh} />}
        <AutoResumeNote project={project} onChanged={refresh} />
        <SafetyReviewNote project={project} />
        <FallbackNote project={project} />
        <ApprovalStepIndicator project={project} />
        <ApprovalBar project={project} onChanged={refresh} />
        <AutomationPanel project={project} />
        <MusicStatus project={project} />
        <SfxStatus project={project} />
        {project.renders.length > 0 && <ShareLinksPanel projectId={project.id} />}
        <div>
          <ReviewTabs tabs={tabs} active={active} onChange={setTab} />
          <TabPanel tab={active}>
            {active === 'slides' && (
              <SlideshowBuilder project={project} businessId={businessId} onChanged={refresh} />
            )}
            {active === 'variants' &&
              (project.renders.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {working ? t('variantsWorking') : t('variantsNone')}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {project.renders.map((r) => (
                    <VariantCard
                      key={r.id}
                      render={r}
                      stale={staleRenderIds(project).has(r.id)}
                      projectState={project.state}
                      onChanged={refresh}
                    />
                  ))}
                </div>
              ))}
            {active === 'shots' && (
              <ShotsTab project={project} onChanged={refresh} businessId={businessId} />
            )}
            {active === 'overlays' && (
              <OverlayEditor project={project} businessId={businessId} onChanged={refresh} />
            )}
            {active === 'script' && <ScriptView project={project} onChanged={refresh} />}
            {active === 'publish' && (
              <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
                <Section title={t('publishTitle')} description={t('publishDescription')}>
                  {PUBLISHABLE.has(project.state) ? (
                    <PublishPanel project={project} businessId={businessId} onChanged={refresh} />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('approveFirst')}</p>
                  )}
                </Section>
                <Section title={t('postsTitle')}>
                  <PublicationsList publications={project.publications} onChanged={refresh} />
                </Section>
              </div>
            )}
          </TabPanel>
        </div>
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
