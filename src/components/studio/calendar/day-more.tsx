'use client';

import { useTranslations } from 'next-intl';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { CalendarEvent } from './calendar-event';
import type { MoveHandlers } from './month-views';
import { OpenSlot } from './open-slot';
import { PlannedSlot } from './planned-slot';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 25.9 — "+n more" on a full month cell: a popover with everything on that day (posts
// with their move / retry buttons, month-plan posts, open slots), so nothing is out of reach
// from the month view. Radix moves focus into it and back to "+n more" on close.

export function DayMore({
  day,
  count,
  events,
  planned,
  open,
  move,
}: {
  day: Date;
  count: number;
  events: readonly Publication[];
  planned: readonly PlannedPost[];
  open: readonly string[];
  move?: MoveHandlers;
}) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const date = f.date(day.toISOString(), { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <Popover>
      <PopoverTrigger
        data-day-more
        aria-label={t('moreAria', { count, date })}
        className="self-start rounded-sm px-1.5 text-[0.7rem] font-medium text-foreground-secondary hover:bg-surface-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {t('more', { count })}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-96 w-80 flex-col gap-1.5 overflow-y-auto">
        <p className="mb-1 text-xs font-medium text-muted-foreground">{date}</p>
        {events.map((p) => (
          <CalendarEvent
            key={p.id}
            publication={p}
            onMove={move?.onMove}
            onRetry={move?.onRetry}
            onOpen={move?.onOpen}
            busy={move?.pendingId === p.id || move?.retryingId === p.id}
          />
        ))}
        {planned.map((post) => (
          <PlannedSlot key={post.itemId} post={post} onOpen={move?.onOpenPlanned} />
        ))}
        {open.map((at) => (
          <OpenSlot key={at} at={at} />
        ))}
      </PopoverContent>
    </Popover>
  );
}
