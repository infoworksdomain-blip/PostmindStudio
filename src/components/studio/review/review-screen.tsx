'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { ACTIVE_STATES, formatPence, PROJECT_STATE, stateOf } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';
import { useBusiness } from '../business-context';
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

// BACKLOG 10.4 — Review (spec 14.2): one screen, all variants. Polls every 4 s while the
// pipeline is working so progress, shots and renders update in place.

export const POLL_MS = 4_000;

const SOURCE_LABEL: Record<string, string> = {
  BRIEF: 'From a brief',
  SLIDESHOW: 'Slideshow',
  LIBRARY_REFERENCE: 'From a reference video',
  POSTMIND_CONTENT: 'From PostMind content',
  TEMPLATE: 'From a template',
  UPLOAD: 'Your video',
};

/** 13.1 / 13.2: renders made before the latest script or shot edits. */
export function staleRenderIds(project: ProjectDetail): Set<string> {
  const list = project.metadata?.staleRenders;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
}

function tabsFor(project: ProjectDetail): TabDef[] {
  const tabs: TabDef[] = [];
  if (project.sourceType === 'SLIDESHOW') tabs.push({ key: 'slides', label: 'Slides' });
  tabs.push(
    { key: 'variants', label: 'Variants' },
    { key: 'shots', label: 'Shots' },
    { key: 'overlays', label: 'Overlays' },
    { key: 'script', label: 'Script' },
    { key: 'publish', label: 'Publish' },
  );
  return tabs;
}

export function ReviewScreen({ projectId }: { projectId: string }) {
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
      <div className="flex flex-col gap-4" aria-label="Loading project">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );

  const { project } = data;
  const tabs = tabsFor(project);
  const active = tab && tabs.some((t) => t.key === tab) ? tab : (tabs[0]?.key ?? 'variants');
  const state = stateOf(PROJECT_STATE, project.state);
  const working = ACTIVE_STATES.has(project.state);

  return (
    <>
      <BackLink />
      <PageHeader
        eyebrow={SOURCE_LABEL[project.sourceType] ?? 'Review'}
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge {...state} />
            <span className="tabular">{formatPence(project.costActualPence)} spent</span>
            {project.costBudgetPence !== null && (
              <span className="tabular">of {formatPence(project.costBudgetPence)} budget</span>
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
              {project.errorReason === 'cancelled_by_user' ? 'Cancelled.' : project.errorReason}
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
                  {working
                    ? 'Variants appear here as each format finishes rendering.'
                    : 'No variants rendered yet.'}
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
                <Section
                  title="Publish"
                  description="Post each approved variant now or schedule it."
                >
                  {PUBLISHABLE.has(project.state) ? (
                    <PublishPanel project={project} businessId={businessId} onChanged={refresh} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Approve the video before publishing it.
                    </p>
                  )}
                </Section>
                <Section title="Posts">
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
  return (
    <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
      <Link href="/projects">
        <ArrowLeft /> Projects
      </Link>
    </Button>
  );
}
