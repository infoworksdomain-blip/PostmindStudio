'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { CalendarEvent } from './calendar-event';
import { dayKey, weekdayNames, type MonthRef } from './month';
import { OpenSlot } from './open-slot';
import { PlannedSlot } from './planned-slot';
import type { PlannedPost } from './use-upcoming-slots';
import { DRAG_TYPE } from './reschedule';

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

// Desktop: a seven-column month grid. Phones: the same month as an agenda of days that have
// something on them (a 7-column grid is unreadable at 375px). 20.3: open drip-queue slots
// (openByDay) follow the day's posts as dashed markers, only in the room a cell has left.

// 4 = the most posts one day can hold (max 4 a day), so a full day never hides a post.
const MAX_PER_CELL = 4;

const NO_OPEN_SLOTS: ReadonlyMap<string, string[]> = new Map();
const NO_PLANNED: ReadonlyMap<string, PlannedPost[]> = new Map();

export function MonthGrid({
  days,
  month,
  byDay,
  openByDay = NO_OPEN_SLOTS,
  plannedByDay = NO_PLANNED,
  today,
  move,
}: {
  days: Date[];
  month: MonthRef;
  byDay: Map<string, Publication[]>;
  /** 20.3: open drip-queue slots by day (ISO instants). */
  openByDay?: ReadonlyMap<string, string[]>;
  /** 20.9: month-plan posts still being made, by day. */
  plannedByDay?: ReadonlyMap<string, PlannedPost[]>;
  today: string;
  move?: MoveHandlers;
}) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  // Monday-first column headings in the locale (getDay order starts on Sunday).
  const weekdays = useMemo(() => {
    const names = weekdayNames(f.locale, 'short');
    return [...names.slice(1), ...names.slice(0, 1)];
  }, [f.locale]);
  const [over, setOver] = useState<string | null>(null);
  const isEmptyMonth = !days.some(
    (d) =>
      d.getMonth() === month.month &&
      (byDay.has(dayKey(d)) || openByDay.has(dayKey(d)) || plannedByDay.has(dayKey(d))),
  );
  return (
    <div className="hidden overflow-hidden rounded-xl border border-border md:block">
      <div className="grid grid-cols-7 border-b border-border bg-secondary/40">
        {weekdays.map((d) => (
          <div
            key={d}
            className="px-2 py-2 text-[0.65rem] font-semibold tracking-[0.18em] text-muted-foreground uppercase"
          >
            {d}
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-7" aria-label={t('daysAria')}>
        {days.map((day) => {
          const key = dayKey(day);
          const events = byDay.get(key) ?? [];
          const planned = plannedByDay.get(key) ?? [];
          const shownPlanned = planned.slice(0, Math.max(0, MAX_PER_CELL - events.length));
          const open = openByDay.get(key) ?? [];
          const shownOpen = open.slice(
            0,
            Math.max(0, MAX_PER_CELL - events.length - shownPlanned.length),
          );
          const inMonth = day.getMonth() === month.month;
          const isToday = key === today;
          return (
            <li
              key={key}
              data-day={key}
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
                'flex min-h-28 min-w-0 flex-col gap-1 border-e border-b border-border/70 p-1.5 [&:nth-child(7n)]:border-e-0',
                !inMonth && 'bg-muted/30',
                over === key && 'bg-primary/10 ring-2 ring-primary/40 ring-inset',
              )}
            >
              <span className="sr-only">{f.date(day.toISOString(), { dateStyle: 'full' })}</span>
              <span
                aria-hidden
                className={cn(
                  'tabular grid size-6 place-items-center self-end rounded-full text-xs',
                  inMonth ? 'text-foreground' : 'text-muted-foreground',
                  isToday && 'bg-primary font-semibold text-primary-foreground',
                )}
              >
                {f.number(day.getDate())}
              </span>
              {events.slice(0, MAX_PER_CELL).map((p) => (
                <CalendarEvent
                  key={p.id}
                  publication={p}
                  compact
                  onMove={move?.onMove}
                  onRetry={move?.onRetry}
                  onOpen={move?.onOpen}
                  busy={move?.pendingId === p.id || move?.retryingId === p.id}
                />
              ))}
              {events.length > MAX_PER_CELL && (
                <span className="px-1.5 text-[0.7rem] text-muted-foreground">
                  {t('more', { count: events.length - MAX_PER_CELL })}
                </span>
              )}
              {shownPlanned.map((post) => (
                <PlannedSlot key={post.itemId} post={post} compact onOpen={move?.onOpenPlanned} />
              ))}
              {planned.length > shownPlanned.length && (
                <span className="px-1.5 text-[0.7rem] text-muted-foreground">
                  {t('morePlanned', { count: planned.length - shownPlanned.length })}
                </span>
              )}
              {shownOpen.map((at) => (
                <OpenSlot key={at} at={at} compact />
              ))}
              {open.length > shownOpen.length && (
                <span className="px-1.5 text-[0.7rem] text-muted-foreground">
                  {t('moreOpen', { count: open.length - shownOpen.length })}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {isEmptyMonth && (
        <p className="border-t border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t('emptyMonth')}
        </p>
      )}
    </div>
  );
}

export function AgendaList({
  days,
  month,
  byDay,
  openByDay = NO_OPEN_SLOTS,
  plannedByDay = NO_PLANNED,
  today,
  move,
}: {
  days: Date[];
  month: MonthRef;
  byDay: Map<string, Publication[]>;
  openByDay?: ReadonlyMap<string, string[]>;
  plannedByDay?: ReadonlyMap<string, PlannedPost[]>;
  today: string;
  move?: MoveHandlers;
}) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const busy = days.filter(
    (d) =>
      d.getMonth() === month.month &&
      (byDay.has(dayKey(d)) || openByDay.has(dayKey(d)) || plannedByDay.has(dayKey(d))),
  );
  if (busy.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground md:hidden">
        {t('emptyMonth')}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-5 md:hidden" aria-label={t('agendaAria')}>
      {busy.map((day) => {
        const key = dayKey(day);
        return (
          <li key={key} className="grid grid-cols-[3rem_1fr] gap-3">
            <div className="text-center">
              <p className="text-[0.65rem] tracking-[0.18em] text-muted-foreground uppercase">
                {f.date(day.toISOString(), { weekday: 'short' })}
              </p>
              <p
                className={cn(
                  'tabular font-display text-3xl leading-none',
                  key === today && 'text-primary',
                )}
              >
                {f.number(day.getDate())}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {(byDay.get(key) ?? []).map((p) => (
                <CalendarEvent
                  key={p.id}
                  publication={p}
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
