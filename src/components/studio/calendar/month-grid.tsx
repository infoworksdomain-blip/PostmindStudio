'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import type { Publication } from '@/lib/client/types';
import { cn } from '@/lib/utils';
import { isRtl } from '@/components/ui/roving';
import { CalendarEvent } from './calendar-event';
import { DayMore } from './day-more';
import { dayKey, weekdayNames, type MonthRef } from './month';
import type { MoveHandlers } from './month-views';
import { OpenSlot } from './open-slot';
import { PlannedSlot } from './planned-slot';
import { DRAG_TYPE } from './reschedule';
import type { PlannedPost } from './use-upcoming-slots';

// BACKLOG 25.9 — the desktop month as an ARIA grid: one row per week, a column header per
// weekday, a gridcell per day. The days are one tab stop (roving focus): arrow keys move a day
// (left / right follow the reading direction) or a week, Home / End go to the week's ends,
// Page Up / Page Down to the month before or after, Enter or Space open the day. Moving the
// focus selects the day (it is kept in the URL). Posts inside a day are ordinary buttons.
// A day shows up to four posts — the daily maximum, so a full day never hides one — and its
// other items (month-plan posts, open slots) behind "+n more".

const MAX_PER_CELL = 4;
const NO_OPEN: ReadonlyMap<string, string[]> = new Map();
const NO_PLANNED: ReadonlyMap<string, PlannedPost[]> = new Map();

export interface MonthGridProps {
  days: Date[];
  month: MonthRef;
  byDay: ReadonlyMap<string, Publication[]>;
  openByDay?: ReadonlyMap<string, string[]>;
  plannedByDay?: ReadonlyMap<string, PlannedPost[]>;
  today: string;
  /** The selected day (local key), if it is in the grid. */
  selected?: string | null;
  /** Keyboard / click selection of a day (focus stays on the grid). */
  onSelect?: (day: Date) => void;
  /** Enter on a day, or its date button: open the day view. */
  onOpenDay?: (day: Date) => void;
  move?: MoveHandlers;
  emptyText: string;
}

/** The day a key press moves to, or null for keys the grid does not handle. */
export function keyTarget(day: Date, key: string, rtl: boolean): Date | null {
  const [y, m, d] = [day.getFullYear(), day.getMonth(), day.getDate()];
  const lead = (day.getDay() + 6) % 7;
  switch (key) {
    case 'ArrowRight':
      return new Date(y, m, d + (rtl ? -1 : 1));
    case 'ArrowLeft':
      return new Date(y, m, d + (rtl ? 1 : -1));
    case 'ArrowDown':
      return new Date(y, m, d + 7);
    case 'ArrowUp':
      return new Date(y, m, d - 7);
    case 'Home':
      return new Date(y, m, d - lead);
    case 'End':
      return new Date(y, m, d + 6 - lead);
    case 'PageUp':
      return new Date(y, m - 1, Math.min(d, new Date(y, m, 0).getDate()));
    case 'PageDown':
      return new Date(y, m + 1, Math.min(d, new Date(y, m + 2, 0).getDate()));
    default:
      return null;
  }
}

export function MonthGrid({
  days,
  month,
  byDay,
  openByDay = NO_OPEN,
  plannedByDay = NO_PLANNED,
  today,
  selected = null,
  onSelect,
  onOpenDay,
  move,
  emptyText,
}: MonthGridProps) {
  const t = useTranslations('calendar.grid');
  const f = useFormat();
  const weekdays = useMemo(() => {
    const short = weekdayNames(f.locale, 'short');
    const long = weekdayNames(f.locale, 'long');
    // Monday first (getDay order starts on Sunday).
    return [1, 2, 3, 4, 5, 6, 0].map((i) => ({ short: short[i], long: long[i] }));
  }, [f.locale]);
  const weeks = useMemo(
    () => Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7)),
    [days],
  );
  const [over, setOver] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const keys = days.map(dayKey);
  const firstInMonth = days.find((d) => d.getMonth() === month.month) ?? days[0];
  const tabStop =
    selected && keys.includes(selected)
      ? selected
      : keys.includes(today)
        ? today
        : dayKey(firstInMonth as Date);
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const cell = grid.current?.querySelector<HTMLElement>(`[data-day="${key}"]`);
    if (cell) {
      cell.focus();
      pendingFocus.current = null;
    }
  });
  const isEmptyMonth = !days.some(
    (d) =>
      d.getMonth() === month.month &&
      (byDay.has(dayKey(d)) || openByDay.has(dayKey(d)) || plannedByDay.has(dayKey(d))),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, day: Date) => {
    if (event.target !== event.currentTarget) return; // keys inside a post are the post's
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenDay?.(day);
      return;
    }
    const next = keyTarget(day, event.key, isRtl(event.currentTarget));
    if (!next) return;
    event.preventDefault();
    pendingFocus.current = dayKey(next);
    onSelect?.(next);
  };

  return (
    <div className="hidden overflow-hidden rounded-panel border border-border bg-card md:block">
      <div role="grid" aria-label={t('daysAria')} ref={grid}>
        <div role="row" className="grid grid-cols-7 border-b border-border">
          {weekdays.map((d) => (
            <div
              key={d.long}
              role="columnheader"
              className="px-2.5 py-2 text-[0.6875rem] font-medium text-muted-foreground"
            >
              <span aria-hidden>{d.short}</span>
              <span className="sr-only">{d.long}</span>
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={dayKey(week[0] as Date)} className="grid grid-cols-7">
            {week.map((day) => {
              const key = dayKey(day);
              const events = byDay.get(key) ?? [];
              const planned = plannedByDay.get(key) ?? [];
              const open = openByDay.get(key) ?? [];
              const room = Math.max(0, MAX_PER_CELL - events.length);
              const shownPlanned = planned.slice(0, room);
              const shownOpen = open.slice(0, Math.max(0, room - shownPlanned.length));
              const hidden =
                Math.max(0, events.length - MAX_PER_CELL) +
                (planned.length - shownPlanned.length) +
                (open.length - shownOpen.length);
              const inMonth = day.getMonth() === month.month;
              const isToday = key === today;
              const isSelected = key === selected;
              return (
                <div
                  key={key}
                  role="gridcell"
                  data-day={key}
                  aria-selected={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  tabIndex={key === tabStop ? 0 : -1}
                  onKeyDown={(e) => onKeyDown(e, day)}
                  onClick={(e) => {
                    if (e.target === e.currentTarget) onSelect?.(day);
                  }}
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
                    'group/day relative flex min-h-30 min-w-0 flex-col gap-1 border-e border-b border-border/70 p-1.5 outline-none last:border-e-0',
                    'focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    !inMonth && 'bg-surface-raised/50',
                    isSelected && 'bg-surface-active/60',
                    over === key && 'bg-signal-soft ring-2 ring-primary/40 ring-inset',
                  )}
                >
                  <span className="sr-only">
                    {f.date(day.toISOString(), { dateStyle: 'full' })}
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => onOpenDay?.(day)}
                    className={cn(
                      'tabular grid size-6 place-items-center self-end rounded-full text-xs transition-colors duration-(--duration-fast) hover:bg-surface-active',
                      inMonth ? 'text-foreground' : 'text-muted-foreground',
                      isToday &&
                        'bg-primary font-semibold text-primary-foreground hover:bg-primary',
                      isSelected && !isToday && 'ring-1 ring-foreground/60',
                    )}
                  >
                    {f.number(day.getDate())}
                  </button>
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
                  {shownPlanned.map((post) => (
                    <PlannedSlot
                      key={post.itemId}
                      post={post}
                      compact
                      onOpen={move?.onOpenPlanned}
                    />
                  ))}
                  {shownOpen.map((at) => (
                    <OpenSlot key={at} at={at} compact />
                  ))}
                  {hidden > 0 && (
                    <DayMore
                      day={day}
                      count={hidden}
                      events={events}
                      planned={planned}
                      open={open}
                      move={move}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {isEmptyMonth && (
        <p className="border-t border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      )}
    </div>
  );
}
