'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/client/format';
import type { ProjectDetail, Render } from '@/lib/client/types';
import type { LiveProjectEvent } from '@/lib/studio/live/events';
import { IN_PROGRESS_STAGES, liveStageOf } from '@/lib/studio/live/eta';
import { ApprovalStepIndicator } from '../approvals/approval-step-indicator';
import { StatusChip } from '../live/status-chip';
import { StateBadge } from '../primitives';
import { AttentionList } from './attention-list';
import type { AttentionItem } from './attention-model';
import { AutomationPanel } from './automation-panel';
import { MusicStatus, readMusic } from './music-status';
import { PipelineStrip } from './pipeline-strip';
import { ApprovalBar, ProjectActions } from './project-actions';
import { ProjectMenu } from './project-menu';
import { SfxStatus, readSfx } from './sfx-status';
import { PUBLISHABLE } from './types';

// BACKLOG 25.8 — the review screen's status & actions column: one status line (the project's state
// and, while it is being made, the live stage with its ETA), the pipeline, the one thing to do next
// (Generate, Approve or Publish — the existing handlers), the actions menu, everything that needs
// attention, and quiet details (how it publishes, music, sound effects).

export function ReviewStatus({
  project,
  projectName,
  selected,
  live,
  attention,
  onChanged,
  onPublish,
}: {
  project: ProjectDetail;
  projectName: string;
  selected: Render | null;
  live: LiveProjectEvent | undefined;
  attention: readonly AttentionItem[];
  onChanged: () => void;
  /** Opens the Publish tab. */
  onPublish: () => void;
}) {
  const t = useTranslations('review.status');
  const f = useFormat();
  const state = f.projectState(project.state);
  const isCarousel = project.sourceType === 'CAROUSEL';
  const stage = liveStageOf(live?.state ?? project.state, null);
  const inProgress = stage !== null && IN_PROGRESS_STAGES.has(stage);
  const urgent = attention.filter((i) => i.tone !== 'info').length;
  const shown = new Set(attention.map((i) => i.key));
  const music = readMusic(project.metadata);
  const sfx = readSfx(project.metadata);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StateBadge {...state} />
          {inProgress && <StatusChip live={live} projectState={project.state} />}
        </div>
        <ProjectMenu
          project={project}
          selected={selected}
          projectName={projectName}
          onChanged={onChanged}
        />
      </div>
      {/* Screen readers hear the stage change and how many things need attention, not the ETA. */}
      <p role="status" className="sr-only">
        {t('announceAttention', { state: state.label, count: urgent })}
      </p>
      <PipelineStrip project={project} />
      <div className="flex flex-col gap-3 empty:hidden">
        <div className="flex flex-wrap gap-2 empty:hidden">
          <ProjectActions project={project} onChanged={onChanged} />
          {PUBLISHABLE.has(project.state) && (
            <Button onClick={onPublish}>
              <Send /> {project.state === 'APPROVED' ? t('publish') : t('posts')}
            </Button>
          )}
        </div>
        <ApprovalBar project={project} onChanged={onChanged} />
      </div>
      <ApprovalStepIndicator project={project} />
      <AttentionList
        items={attention}
        project={project}
        isCarousel={isCarousel}
        onChanged={onChanged}
      />
      <Details>
        {!shown.has('automation') && (
          <AutomationPanel project={project} onChanged={onChanged} saveTemplate={false} />
        )}
        {music && music.status !== 'failed' && <MusicStatus project={project} />}
        {sfx && sfx.status !== 'failed' && <SfxStatus project={project} />}
      </Details>
    </div>
  );
}

function Details({ children }: { children: ReactNode }) {
  const t = useTranslations('review.status');
  return (
    <section aria-label={t('details')} className="flex flex-col gap-2 empty:hidden">
      {children}
    </section>
  );
}
