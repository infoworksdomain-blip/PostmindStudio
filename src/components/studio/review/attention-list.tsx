'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, ChevronDown, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ProjectDetail } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { FailureReason } from '../failure-reason';
import { AutomationPanel } from './automation-panel';
import { BudgetRaise } from './budget-raise';
import { DirectionsPanel } from './directions-panel';
import { MusicStatus } from './music-status';
import {
  ActorFallbackNote,
  AutoResumeNote,
  FallbackNote,
  PresenterFallbackNote,
  QueuedNote,
  SafetyReviewNote,
} from './paused-notes';
import { RestrictedTopicsPanel } from './restricted-topics-panel';
import { SfxStatus } from './sfx-status';
import { UgcRefusedPanel } from './ugc-refused-panel';
import type { AttentionItem, AttentionKey, AttentionTone } from './attention-model';

// BACKLOG 25.8 — "Needs your attention": every notice about this project as one compact row
// (things to do first, then warnings, then good-to-know). A row expands to the notice's own panel
// — the same component, with its own actions — so nothing about how each notice works changed.
// Rows that need a decision start open (the projects list links straight to their anchors).

const TONE_ICON: Record<AttentionTone, LucideIcon> = {
  action: AlertCircle,
  warning: TriangleAlert,
  info: Info,
};

const TONE_CLASS: Record<AttentionTone, string> = {
  action: 'text-destructive',
  warning: 'text-warning-foreground',
  info: 'text-muted-foreground',
};

function Panel({
  item,
  project,
  isCarousel,
  onChanged,
}: {
  item: AttentionKey;
  project: ProjectDetail;
  isCarousel: boolean;
  onChanged: () => void;
}): ReactNode {
  switch (item) {
    case 'directions':
      return <DirectionsPanel project={project} onChanged={onChanged} />;
    case 'ugcRefused':
      return <UgcRefusedPanel project={project} onChanged={onChanged} />;
    case 'restrictedTopics':
      return <RestrictedTopicsPanel project={project} onChanged={onChanged} />;
    case 'failure':
      return (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
        >
          <FailureReason reason={project.errorReason ?? ''} />
        </p>
      );
    case 'budget':
      return isCarousel ? null : <BudgetRaise project={project} onChanged={onChanged} />;
    case 'autoResume':
      return <AutoResumeNote project={project} onChanged={onChanged} />;
    case 'safetyReview':
      return <SafetyReviewNote project={project} />;
    case 'automation':
      return <AutomationPanel project={project} onChanged={onChanged} saveTemplate={false} />;
    case 'music':
      return <MusicStatus project={project} />;
    case 'sfx':
      return <SfxStatus project={project} />;
    case 'queued':
      return <QueuedNote project={project} />;
    case 'fallback':
      return <FallbackNote project={project} />;
    case 'presenterFallback':
      return <PresenterFallbackNote project={project} />;
    case 'actorFallback':
      return <ActorFallbackNote project={project} />;
  }
}

/** The row title: the failure row says what kind of stop it was. */
function titleKey(
  key: AttentionKey,
  state: string,
): Exclude<AttentionKey, 'failure'> | 'failureRejected' | 'failureQuality' | 'failureFailed' {
  if (key !== 'failure') return key;
  if (state === 'REJECTED') return 'failureRejected';
  return state === 'QUALITY_FAILED' ? 'failureQuality' : 'failureFailed';
}

function AttentionRow({
  item,
  project,
  isCarousel,
  onChanged,
}: {
  item: AttentionItem;
  project: ProjectDetail;
  isCarousel: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('review.attention');
  const [open, setOpen] = useState(item.tone === 'action');
  const panelId = useId();
  const Icon = TONE_ICON[item.tone];
  return (
    <li
      data-attention={item.key}
      data-tone={item.tone}
      className="border-b border-border/70 last:border-b-0"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-md px-1 py-2.5 text-start text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Icon
          aria-hidden
          strokeWidth={1.75}
          className={cn('size-4 shrink-0', TONE_CLASS[item.tone])}
        />
        <span className="min-w-0 flex-1 font-medium">
          {t(`items.${titleKey(item.key, project.state)}`)}
        </span>
        <span className="sr-only">{t(`tones.${item.tone}`)}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground motion-safe:transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      <div id={panelId} hidden={!open} className="pb-3">
        {open && (
          <Panel item={item.key} project={project} isCarousel={isCarousel} onChanged={onChanged} />
        )}
      </div>
    </li>
  );
}

export function AttentionList({
  items,
  project,
  isCarousel,
  onChanged,
}: {
  items: readonly AttentionItem[];
  project: ProjectDetail;
  isCarousel: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('review.attention');
  const headingId = useId();
  if (items.length === 0) return null;
  const urgent = items.some((i) => i.tone !== 'info');
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
        {urgent ? t('title') : t('titleInfo')}
        <span className="tabular rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
          {items.length}
        </span>
      </h2>
      <ul className="flex flex-col">
        {items.map((item) => (
          <AttentionRow
            key={item.key}
            item={item}
            project={project}
            isCarousel={isCarousel}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </section>
  );
}
