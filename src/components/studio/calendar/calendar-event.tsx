'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CalendarClock, RotateCw } from 'lucide-react';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { eventTime, formatTime } from './month';
import { canMove, DRAG_TYPE } from './reschedule';
import { canRetry } from './retry';
import { useProjectName } from '@/lib/client/use-project-name';

// One publication on the calendar: a thin state-coloured rule, time, platform and video name.
// Links to the project. A scheduled one can be dragged to another day (13.9) or moved with its
// "Move to" button (keyboard and phone alternative to dragging).

const RULE: Record<string, string> = {
  SCHEDULED: 'border-s-muted-foreground/60',
  PUBLISHING: 'border-s-primary',
  PUBLISHED: 'border-s-success',
  FAILED: 'border-s-destructive bg-destructive/10',
};

export function CalendarEvent({
  publication,
  compact = false,
  onMove,
  onRetry,
  busy = false,
}: {
  publication: Publication;
  compact?: boolean;
  /** Opens the move dialog; scheduled publications only. Absent = read-only. */
  onMove?: (publication: Publication) => void;
  /** Retries a failed publication; failed ones only. Absent = no retry button. */
  onRetry?: (publication: Publication) => void;
  busy?: boolean;
}) {
  const t = useTranslations('calendar.event');
  const f = useFormat();
  const at = eventTime(publication);
  const time = at ? formatTime(at, f.locale) : null;
  const platform = f.platform(publication.platform);
  const state = f.publicationState(publication.state).label;
  const projectName = useProjectName();
  const name = projectName(publication.project?.name);
  const movable = Boolean(onMove) && canMove(publication);
  const link = (
    <Link
      href={`/projects/${publication.projectId}`}
      title={t('title', { name, platform, state })}
      aria-label={
        time ? t('ariaAt', { name, platform, state, time }) : t('aria', { name, platform, state })
      }
      className={cn(
        'block min-w-0 rounded-sm border-s-2 bg-secondary/60 transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        RULE[publication.state] ?? 'border-s-border',
        compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
        movable && 'flex-1 cursor-grab active:cursor-grabbing',
        busy && 'opacity-50',
      )}
    >
      <span className="flex items-baseline gap-1.5">
        {publication.state === 'FAILED' && (
          <AlertTriangle aria-hidden className="size-3 shrink-0 self-center text-destructive" />
        )}
        {time && <span className="tabular shrink-0 text-muted-foreground">{time}</span>}
        <span className="truncate font-medium">{name}</span>
      </span>
      {!compact && (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {t('meta', { platform, state })}
        </span>
      )}
    </Link>
  );
  if (onRetry && canRetry(publication)) {
    return (
      <div className="flex min-w-0 items-stretch gap-0.5">
        {link}
        <button
          type="button"
          aria-label={t('retryAria', { name })}
          title={t('retryTitle')}
          disabled={busy}
          onClick={() => onRetry(publication)}
          className="grid shrink-0 place-items-center rounded-sm px-1 text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          <RotateCw className={compact ? 'size-3' : 'size-4'} />
        </button>
      </div>
    );
  }
  if (!movable) return link;
  return (
    <div
      className="flex min-w-0 items-stretch gap-0.5"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, publication.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {link}
      <button
        type="button"
        aria-label={t('moveAria', { name })}
        title={t('moveTitle')}
        disabled={busy}
        onClick={() => onMove?.(publication)}
        className="grid shrink-0 place-items-center rounded-sm px-1 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      >
        <CalendarClock className={compact ? 'size-3' : 'size-4'} />
      </button>
    </div>
  );
}
