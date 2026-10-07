'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Dialog as PanelPrimitive } from 'radix-ui';
import { ExternalLink, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { useProjectName } from '@/lib/client/use-project-name';
import type { PostPreview } from '@/lib/studio/services/post-preview';
import { cn } from '@/lib/utils';
import { useLiveStatus } from '../live/live-projects-context';
import { StatusChip } from '../live/status-chip';
import { PostPreviewPlayer } from '../preview/post-preview-player';
import { ErrorState } from '../primitives';
import { PostPanelActions } from './post-panel-actions';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 24.2 — clicking a calendar post opens this side panel instead of leaving the calendar:
// the instant preview (Remotion Player), caption and hashtags, networks, scheduled time, live
// status and the actions that already exist elsewhere. A Radix dialog: focus is trapped inside,
// Escape and the close button close it and focus returns to the card. It sits at the inline END
// (right in English, left in Arabic) and is a full-height sheet on phones. Logical CSS only.

export type PanelTarget =
  { kind: 'publication'; publication: Publication } | { kind: 'planned'; post: PlannedPost };

export function panelProjectId(target: PanelTarget): string | null {
  return target.kind === 'publication'
    ? target.publication.projectId
    : (target.post.projectId ?? null);
}

export interface PostPanelProps {
  target: PanelTarget | null;
  onClose: () => void;
  onReschedule: (publication: Publication) => void;
  onChanged: () => void;
}

export function PostPanel({ target, onClose, onReschedule, onChanged }: PostPanelProps) {
  const t = useTranslations('calendar.panel');
  return (
    <PanelPrimitive.Root open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <PanelPrimitive.Portal>
        <PanelPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim/35 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <PanelPrimitive.Content
          data-testid="post-panel"
          aria-describedby={undefined}
          className={cn(
            'fixed inset-y-0 end-0 z-50 flex h-full w-full flex-col overflow-y-auto bg-popover text-sm text-popover-foreground shadow-xl sm:max-w-md sm:border-s sm:border-border',
            'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
          )}
        >
          {target && (
            <PanelBody target={target} onReschedule={onReschedule} onChanged={onChanged} />
          )}
          <PanelPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute end-3 top-3"
              aria-label={t('close')}
            >
              <XIcon />
            </Button>
          </PanelPrimitive.Close>
        </PanelPrimitive.Content>
      </PanelPrimitive.Portal>
    </PanelPrimitive.Root>
  );
}

function PanelBody({
  target,
  onReschedule,
  onChanged,
}: {
  target: PanelTarget;
  onReschedule: (publication: Publication) => void;
  onChanged: () => void;
}) {
  const projectId = panelProjectId(target);
  if (target.kind === 'planned' && !projectId) return <PlannedOnly post={target.post} />;
  return (
    <ProjectBody
      projectId={projectId ?? ''}
      target={target}
      onReschedule={onReschedule}
      onChanged={onChanged}
    />
  );
}

/** A month-plan post that has no project yet: its topic, time and status, and its plan. */
function PlannedOnly({ post }: { post: PlannedPost }) {
  const t = useTranslations('calendar.panel');
  const ts = useTranslations('plans.itemStatus');
  const f = useFormat();
  return (
    <div className="flex flex-col gap-4 p-5 pe-12">
      <PanelPrimitive.Title className="font-display text-2xl leading-tight">
        {post.title}
      </PanelPrimitive.Title>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">{t('scheduled')}</dt>
        <dd>{f.date(post.slotAt, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt className="text-muted-foreground">{t('status')}</dt>
        <dd>{ts(post.status)}</dd>
      </dl>
      <p className="text-muted-foreground">{t('notMadeYet')}</p>
      <Button variant="outline" asChild className="self-start">
        <Link href={`/plans/${post.planId}`}>
          <ExternalLink className="rtl:-scale-x-100" /> {t('openPlan')}
        </Link>
      </Button>
    </div>
  );
}

function ProjectBody({
  projectId,
  target,
  onReschedule,
  onChanged,
}: {
  projectId: string;
  target: PanelTarget;
  onReschedule: (publication: Publication) => void;
  onChanged: () => void;
}) {
  const t = useTranslations('calendar.panel');
  const f = useFormat();
  const projectName = useProjectName();
  const { data, error, mutate } = useApi<{ preview: PostPreview }>(
    `/projects/${projectId}/preview`,
  );
  const live = useLiveStatus(projectId);
  const preview = data?.preview;
  // A live stage change (e.g. composing → ready) brings the new render / thumbnail in.
  const liveState = live?.state;
  useEffect(() => {
    if (liveState) void mutate();
  }, [liveState, mutate]);
  const publication = target.kind === 'publication' ? target.publication : null;
  const title =
    preview?.name !== undefined
      ? projectName(preview.name)
      : target.kind === 'planned'
        ? target.post.title
        : projectName(target.publication.project?.name);
  const changed = () => {
    void mutate();
    onChanged();
  };
  return (
    <div className="flex flex-col gap-4 p-5">
      <header className="flex flex-col gap-2 pe-8">
        <PanelPrimitive.Title className="font-display text-2xl leading-tight">
          {title}
        </PanelPrimitive.Title>
        <StatusChip
          live={live ?? preview?.live}
          projectState={preview?.state}
          publicationState={publication?.state}
          className="self-start"
        />
      </header>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {!preview && !error && (
        <Skeleton aria-label={t('loading')} className="aspect-[9/16] w-full rounded-lg" />
      )}
      {preview && (
        <>
          <PostPreviewPlayer preview={preview} />
          <section aria-labelledby="post-panel-caption" className="flex flex-col gap-1.5">
            <h3 id="post-panel-caption" className="text-xs font-semibold text-muted-foreground">
              {t('caption')}
            </h3>
            <p className="whitespace-pre-line">{preview.caption ?? t('noCaption')}</p>
            {preview.hashtags.length > 0 && (
              <p className="text-primary">{preview.hashtags.map((h) => `#${h}`).join(' ')}</p>
            )}
          </section>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t('platforms')}</dt>
            <dd>
              {preview.platforms.length
                ? preview.platforms.map((p) => f.platform(p)).join(', ')
                : t('noPlatforms')}
            </dd>
            <dt className="text-muted-foreground">{t('scheduled')}</dt>
            <dd>
              {(publication?.scheduledFor ?? preview.scheduledFor)
                ? f.date((publication?.scheduledFor ?? preview.scheduledFor) as string, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : t('notScheduled')}
            </dd>
          </dl>
          <PostPanelActions
            projectId={projectId}
            state={live?.state ?? preview.state}
            publication={publication}
            onReschedule={onReschedule}
            onChanged={changed}
          />
        </>
      )}
    </div>
  );
}
