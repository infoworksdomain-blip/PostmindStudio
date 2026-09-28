'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { CalendarEvent } from './calendar-event';
import { dayKey, weekdayNames, type MonthRef } from './month';
import { DRAG_TYPE } from './reschedule';

/** Reschedule wiring (13.9); absent = a read-only calendar. */
export interface MoveHandlers {
  onMove: (publication: Publication) => void;
  onDropOnDay: (publicationId: string, day: Date) => void;
  pendingId: string | null;
}

// Desktop: a seven-column month grid. Phones: the same month as an agenda of days that have
// something on them (a 7-column grid is unreadable at 375px).

const MAX_PER_CELL = 3;

export function MonthGrid({
  days,
  month,
  byDay,
  today,
  move,
}: {
  days: Date[];
  month: MonthRef;
  byDay: Map<string, Publication[]>;
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
                  inMonth ? 'text-foreground' : 'text-muted-foreground/60',
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
                  busy={move?.pendingId === p.id}
                />
              ))}
              {events.length > MAX_PER_CELL && (
                <span className="px-1.5 text-[0.7rem] text-muted-foreground">
                  {t('more', { count: events.length - MAX_PER_CELL })}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function AgendaList({
  days,
  month,
  byDay,
  today,
  move,
}: {
  days: Date[];
  month: MonthRef;
  byDay: Map<string, Publication[]>;
  today: string;
  move?: MoveHandlers;
}) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const busy = days.filter((d) => d.getMonth() === month.month && byDay.has(dayKey(d)));
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
                  busy={move?.pendingId === p.id}
                />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
