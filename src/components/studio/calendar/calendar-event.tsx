'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CalendarClock, RotateCw } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { eventTime, formatTime } from './month';
import { canMove, DRAG_TYPE } from './reschedule';
import { canRetry } from './retry';
import { useProjectName } from '@/lib/client/use-project-name';
import { usePublicationBadge } from '../publications/tiktok-draft';
import { useLiveStatus } from '../live/live-projects-context';
import { StatusChip } from '../live/status-chip';

// One publication on the calendar: a thin state-coloured rule, time, platform and video name.
// 24.2: opens the side panel (onOpen) with a live status chip; without onOpen it links to the
// project. A scheduled one can be dragged to another day (13.9) or moved with its
// "Move to" button (keyboard and phone alternative to dragging).

const RULE: Record<string, string> = {
  SCHEDULED: 'border-s-muted-foreground/60',
  PUBLISHING: 'border-s-primary',
  PUBLISHED: 'border-s-success',
  FAILED: 'border-s-destructive bg-destructive-soft',
};

export function CalendarEvent({
  publication,
  compact = false,
  onMove,
  onRetry,
  onOpen,
  busy = false,
}: {
  publication: Publication;
  compact?: boolean;
  /** Opens the move dialog; scheduled publications only. Absent = read-only. */
  onMove?: (publication: Publication) => void;
  /** Retries a failed publication; failed ones only. Absent = no retry button. */
  onRetry?: (publication: Publication) => void;
  /** 24.2: opens the side panel; absent = the card links to the project page. */
  onOpen?: (publication: Publication) => void;
  busy?: boolean;
}) {
  const t = useTranslations('calendar.event');
  const f = useFormat();
  const at = eventTime(publication);
  const time = at ? formatTime(at, f.locale) : null;
  const platform = f.platform(publication.platform);
  const badgeFor = usePublicationBadge(); // 22.7: "Sent to TikTok drafts" for inbox uploads
  const state = badgeFor(publication).label;
  const projectName = useProjectName();
  const name = projectName(publication.project?.name);
  const movable = Boolean(onMove) && canMove(publication);
  const live = useLiveStatus(publication.projectId); // 24.2
  const label = time
    ? t('ariaAt', { name, platform, state, time })
    : t('aria', { name, platform, state });
  const className = cn(
    'block min-w-0 rounded-sm border-s-2 bg-secondary/60 text-start transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    RULE[publication.state] ?? 'border-s-border',
    compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
    movable && 'flex-1 cursor-grab active:cursor-grabbing',
    onOpen && !movable && 'w-full',
    busy && 'opacity-50',
  );
  const content = (
    <>
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
      <StatusChip
        live={live}
        publicationState={publication.state}
        compact={compact}
        className="mt-0.5"
      />
    </>
  );
  const link = onOpen ? (
    <button
      type="button"
      title={t('title', { name, platform, state })}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => onOpen(publication)}
      className={className}
    >
      {content}
    </button>
  ) : (
    <Link
      href={`/projects/${publication.projectId}`}
      title={t('title', { name, platform, state })}
      aria-label={label}
      className={className}
    >
      {content}
    </Link>
  );
  if (onRetry && canRetry(publication)) {
    return (
      <div className="flex min-w-0 items-stretch gap-0.5">
        {link}
        <IconButton
          label={t('retryAria', { name })}
          size={compact ? 'icon-xs' : 'icon-sm'}
          disabled={busy}
          onClick={() => onRetry(publication)}
          className="self-center rounded-sm text-destructive-foreground hover:bg-destructive-soft hover:text-destructive-foreground"
        >
          <RotateCw />
        </IconButton>
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
      <IconButton
        label={t('moveAria', { name })}
        size={compact ? 'icon-xs' : 'icon-sm'}
        disabled={busy}
        onClick={() => onMove?.(publication)}
        className="self-center rounded-sm"
      >
        <CalendarClock />
      </IconButton>
    </div>
  );
}
