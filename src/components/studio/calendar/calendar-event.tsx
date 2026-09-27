'use client';

import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { PLATFORM_LABEL, PUBLICATION_STATE, stateOf } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { eventTime, formatTime } from './month';
import { canMove, DRAG_TYPE } from './reschedule';

// One publication on the calendar: a thin state-coloured rule, time, platform and video name.
// Links to the project. A scheduled one can be dragged to another day (13.9) or moved with its
// "Move to" button (keyboard and phone alternative to dragging).

const RULE: Record<string, string> = {
  SCHEDULED: 'border-l-muted-foreground/60',
  PUBLISHING: 'border-l-primary',
  PUBLISHED: 'border-l-success',
};

export function CalendarEvent({
  publication,
  compact = false,
  onMove,
  busy = false,
}: {
  publication: Publication;
  compact?: boolean;
  /** Opens the move dialog; scheduled publications only. Absent = read-only. */
  onMove?: (publication: Publication) => void;
  busy?: boolean;
}) {
  const at = eventTime(publication);
  const platform = PLATFORM_LABEL[publication.platform] ?? publication.platform;
  const state = stateOf(PUBLICATION_STATE, publication.state);
  const name = publication.project?.name ?? 'Untitled project';
  const movable = Boolean(onMove) && canMove(publication);
  const link = (
    <Link
      href={`/projects/${publication.projectId}`}
      title={`${name} — ${platform} — ${state.label}`}
      aria-label={`${name}, ${platform}, ${state.label}${at ? ` at ${formatTime(at)}` : ''}`}
      className={cn(
        'block min-w-0 rounded-sm border-l-2 bg-secondary/60 transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        RULE[publication.state] ?? 'border-l-border',
        compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
        movable && 'flex-1 cursor-grab active:cursor-grabbing',
        busy && 'opacity-50',
      )}
    >
      <span className="flex items-baseline gap-1.5">
        {at && <span className="tabular shrink-0 text-muted-foreground">{formatTime(at)}</span>}
        <span className="truncate font-medium">{name}</span>
      </span>
      {!compact && (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {platform} · {state.label}
        </span>
      )}
    </Link>
  );
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
        aria-label={`Move ${name} to another time`}
        title="Move to another time"
        disabled={busy}
        onClick={() => onMove?.(publication)}
        className="grid shrink-0 place-items-center rounded-sm px-1 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
      >
        <CalendarClock className={compact ? 'size-3' : 'size-4'} />
      </button>
    </div>
  );
}
