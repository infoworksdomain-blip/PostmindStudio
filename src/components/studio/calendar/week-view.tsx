'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { CalendarEvent } from './calendar-event';
import { dayKey } from './month';
import type { MoveHandlers } from './month-views';
import { OpenSlot } from './open-slot';
import { PlannedSlot } from './planned-slot';
import { DRAG_TYPE } from './reschedule';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 25.9 — the desktop week (seven columns) and day (one wide column) views over the same
// data as the month: every post with its thumbnail, time, network, status and campaign, then the
// month-plan posts still being made and the open posting times. Each day is a drop target (drag
// a scheduled post onto another day, same time of day) and its heading opens that day.

const NO_OPEN: ReadonlyMap<string, string[]> = new Map();
const NO_PLANNED: ReadonlyMap<string, PlannedPost[]> = new Map();

export interface WeekViewProps {
  days: Date[];
  byDay: ReadonlyMap<string, Publication[]>;
  openByDay?: ReadonlyMap<string, string[]>;
  plannedByDay?: ReadonlyMap<string, PlannedPost[]>;
  today: string;
  selected?: string | null;
  onOpenDay?: (day: Date) => void;
  move?: MoveHandlers;
}

export function WeekView({
  days,
  byDay,
  openByDay = NO_OPEN,
  plannedByDay = NO_PLANNED,
  today,
  selected = null,
  onOpenDay,
  move,
}: WeekViewProps) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const [over, setOver] = useState<string | null>(null);
  const single = days.length === 1;
  return (
    <ol
      aria-label={single ? t('dayAria') : t('weekAria')}
      className={cn(
        'hidden overflow-hidden rounded-panel border border-border bg-card md:grid',
        single ? 'grid-cols-1' : 'grid-cols-7',
      )}
    >
      {days.map((day) => {
        const key = dayKey(day);
        const events = byDay.get(key) ?? [];
        const planned = plannedByDay.get(key) ?? [];
        const open = openByDay.get(key) ?? [];
        const isToday = key === today;
        const empty = events.length + planned.length + open.length === 0;
        const heading = f.date(day.toISOString(), {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        });
        return (
          <li
            key={key}
            data-day={key}
            aria-current={isToday ? 'date' : undefined}
            onDragOver={(e) => {
              if (!move || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOver(key);
            }}
            onDragLeave={() => setOver((k) => (k === key ? null : k))}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData(DRAG_TYPE);
              if (!move || !id) return;
              e.preventDefault();
              move.onDropOnDay(id, day);
            }}
            className={cn(
              'flex min-h-[28rem] min-w-0 flex-col gap-1.5 border-e border-border/70 p-2 last:border-e-0',
              key === selected && !single && 'bg-surface-active/50',
              over === key && 'bg-signal-soft ring-2 ring-primary/40 ring-inset',
            )}
          >
            <h3 className="mb-1">
              <button
                type="button"
                disabled={single || !onOpenDay}
                onClick={() => onOpenDay?.(day)}
                aria-label={isToday ? t('todayAria', { date: heading }) : heading}
                className="flex w-full items-baseline gap-2 rounded-control px-1 py-1 text-start transition-colors duration-(--duration-fast) enabled:hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
              >
                <span className="text-[0.6875rem] font-medium text-muted-foreground">
                  {f.date(day.toISOString(), { weekday: single ? 'long' : 'short' })}
                </span>
                <span
                  className={cn(
                    'tabular grid size-7 place-items-center rounded-full text-sm font-semibold',
                    isToday && 'bg-primary text-primary-foreground',
                  )}
                >
                  {f.number(day.getDate())}
                </span>
              </button>
            </h3>
            {empty && <p className="px-1 text-xs text-muted-foreground/80">{t('quietDay')}</p>}
            <div className={cn('flex min-w-0 flex-col gap-1.5', single && 'max-w-2xl')}>
              {events.map((p) => (
                <CalendarEvent
                  key={p.id}
                  publication={p}
                  media
                  compact={!single}
                  onMove={move?.onMove}
                  onRetry={move?.onRetry}
                  onOpen={move?.onOpen}
                  busy={move?.pendingId === p.id || move?.retryingId === p.id}
                />
              ))}
              {planned.map((post) => (
                <PlannedSlot
                  key={post.itemId}
                  post={post}
                  compact={!single}
                  onOpen={move?.onOpenPlanned}
                />
              ))}
              {open.map((at) => (
                <OpenSlot key={at} at={at} compact={!single} />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
