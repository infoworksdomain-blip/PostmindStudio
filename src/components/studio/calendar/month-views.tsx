'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { CalendarEvent } from './calendar-event';
import { dayKey } from './month';
import { OpenSlot } from './open-slot';
import { PlannedSlot } from './planned-slot';
import type { PlannedPost } from './use-upcoming-slots';

/** Reschedule wiring (13.9); absent = a read-only calendar. */
export interface MoveHandlers {
  onMove: (publication: Publication) => void;
  onDropOnDay: (publicationId: string, day: Date) => void;
  pendingId: string | null;
  /** Retry a failed publication. */
  onRetry?: (publication: Publication) => void;
  retryingId?: string | null;
  /** 24.2: open a post in the side panel. */
  onOpen?: (publication: Publication) => void;
  onOpenPlanned?: (post: PlannedPost) => void;
}

// Phones: the month as an agenda of the days that have something on them (a 7-column grid is
// unreadable at 375px); 25.9: the week and day views list every day, empty ones quietly. The
// desktop month grid is month-grid.tsx, the desktop week / day columns week-view.tsx. 20.3: open
// drip-queue slots (openByDay) follow the day's posts as dashed markers.

const NO_OPEN_SLOTS: ReadonlyMap<string, string[]> = new Map();
const NO_PLANNED: ReadonlyMap<string, PlannedPost[]> = new Map();

export interface AgendaListProps {
  days: Date[];
  /** Days that belong to the view (the month's own days; every day of a week). */
  inView: (day: Date) => boolean;
  byDay: ReadonlyMap<string, Publication[]>;
  openByDay?: ReadonlyMap<string, string[]>;
  plannedByDay?: ReadonlyMap<string, PlannedPost[]>;
  today: string;
  move?: MoveHandlers;
  /** 25.9: list empty days too (week and day views), with a quiet line. */
  showEmptyDays?: boolean;
  /** 25.9: thumbnails on the posts (week and day views). */
  media?: boolean;
  emptyText: string;
}

export function AgendaList({
  days,
  inView,
  byDay,
  openByDay = NO_OPEN_SLOTS,
  plannedByDay = NO_PLANNED,
  today,
  move,
  showEmptyDays = false,
  media = false,
  emptyText,
}: AgendaListProps) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const has = (d: Date) =>
    byDay.has(dayKey(d)) || openByDay.has(dayKey(d)) || plannedByDay.has(dayKey(d));
  const listed = days.filter((d) => inView(d) && (showEmptyDays || has(d)));
  if (!days.some((d) => inView(d) && has(d)) && !showEmptyDays) {
    return (
      <p className="rounded-panel border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground md:hidden">
        {emptyText}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-5 md:hidden" aria-label={t('agendaAria')}>
      {listed.map((day) => {
        const key = dayKey(day);
        const busy = has(day);
        return (
          <li key={key} className="grid grid-cols-[3rem_1fr] gap-3" data-agenda-day={key}>
            <div className="text-center">
              <p className="text-[0.6875rem] text-muted-foreground">
                {f.date(day.toISOString(), { weekday: 'short' })}
              </p>
              <p
                className={cn(
                  'tabular mx-auto grid size-9 place-items-center rounded-full text-xl leading-none font-semibold',
                  key === today && 'bg-primary text-primary-foreground',
                )}
              >
                {f.number(day.getDate())}
              </p>
              {key === today && <span className="sr-only">{t('today')}</span>}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {!busy && <p className="py-2 text-sm text-muted-foreground">{t('quietDay')}</p>}
              {(byDay.get(key) ?? []).map((p) => (
                <CalendarEvent
                  key={p.id}
                  publication={p}
                  media={media}
                  onMove={move?.onMove}
                  onRetry={move?.onRetry}
                  onOpen={move?.onOpen}
                  busy={move?.pendingId === p.id || move?.retryingId === p.id}
                />
              ))}
              {(plannedByDay.get(key) ?? []).map((post) => (
                <PlannedSlot key={post.itemId} post={post} onOpen={move?.onOpenPlanned} />
              ))}
              {(openByDay.get(key) ?? []).map((at) => (
                <OpenSlot key={at} at={at} />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
