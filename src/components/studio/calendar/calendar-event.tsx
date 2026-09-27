'use client';

import Link from 'next/link';
import { PLATFORM_LABEL, PUBLICATION_STATE, stateOf } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { eventTime, formatTime } from './month';

// One publication on the calendar: a thin state-coloured rule, time, platform and video name.
// Links to the project, where it can be rescheduled or cancelled.

const RULE: Record<string, string> = {
  SCHEDULED: 'border-l-muted-foreground/60',
  PUBLISHING: 'border-l-primary',
  PUBLISHED: 'border-l-success',
};

export function CalendarEvent({
  publication,
  compact = false,
}: {
  publication: Publication;
  compact?: boolean;
}) {
  const at = eventTime(publication);
  const platform = PLATFORM_LABEL[publication.platform] ?? publication.platform;
  const state = stateOf(PUBLICATION_STATE, publication.state);
  const name = publication.project?.name ?? 'Untitled project';
  return (
    <Link
      href={`/projects/${publication.projectId}`}
      title={`${name} — ${platform} — ${state.label}`}
      aria-label={`${name}, ${platform}, ${state.label}${at ? ` at ${formatTime(at)}` : ''}`}
      className={cn(
        'block min-w-0 rounded-sm border-l-2 bg-secondary/60 transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        RULE[publication.state] ?? 'border-l-border',
        compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
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
}
