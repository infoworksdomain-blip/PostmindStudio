'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarRange, ChevronLeft, ChevronRight, List, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { ErrorState, PageHeader } from '../primitives';
import {
  dayKey,
  formatMonth,
  gridWindow,
  groupByDay,
  groupOpenByDay,
  monthGrid,
  monthOf,
  moveToDay,
  shiftMonth,
} from './month';
import { useBusiness } from '../business-context';
import { DripQueuePanel } from './drip-queue';
import { MonthAheadSummary } from './open-slot';
import { groupPlannedByDay } from './planned-slot';
import { summaryWindow, useUpcomingSlots } from './use-upcoming-slots';
import { AgendaList, MonthGrid, type MoveHandlers } from './month-views';
import { MoveToDialog, useReschedule } from './reschedule';
import type { Publication } from '@/lib/client/types';
import { MAX_PAGES, PAGE_LIMIT, useCalendarPublications } from './use-calendar-publications';

// BACKLOG 10.5 — Manage: calendar of scheduled and published videos (spec 14.3), from
// GET /publications with a from/to window. Month grid on desktop, agenda list on phones.
// Scheduled posts can be dragged to another day or moved with the move dialog (13.9).
// 20.3: open drip-queue slots of the active business show as dashed markers for the visible
// range, with a "Next 30 days" summary above the grid (GET …/drip-queue/upcoming).

export function PublicationsCalendar({ initialDate }: { initialDate?: Date }) {
  const t = useTranslations('calendar');
  const tn = useTranslations('shell.nav.groups');
  const f = useFormat();
  const [month, setMonth] = useState(() => monthOf(initialDate ?? new Date()));
  const days = useMemo(() => monthGrid(month), [month]);
  const range = useMemo(() => gridWindow(month), [month]);
  const today = dayKey(new Date());
  const { data, error, isLoading, isValidating, mutate } = useCalendarPublications(
    range.from,
    range.to,
  );
  const byDay = useMemo(() => groupByDay(data?.publications ?? []), [data]);
  const { businessId } = useBusiness();
  const [openedAt] = useState(() => Date.now());
  const summary = useUpcomingSlots(businessId, summaryWindow(openedAt), openedAt);
  const visible = useUpcomingSlots(businessId, range, openedAt);
  const openByDay = useMemo(
    () => groupOpenByDay(visible.data?.upcoming?.openSlots ?? []),
    [visible.data],
  );
  // 20.9: month-plan posts still being made (scheduled ones are publications already).
  const plannedByDay = useMemo(
    () => groupPlannedByDay(visible.data?.upcoming?.planned ?? [], dayKey),
    [visible.data],
  );
  const refreshSlots = () => {
    void summary.mutate();
    void visible.mutate();
  };
  const title = formatMonth(month, f.locale);
  const [moving, setMoving] = useState<Publication | null>(null);
  const { move, pending } = useReschedule(() => void mutate());
  const moveHandlers: MoveHandlers = {
    onMove: setMoving,
    pendingId: pending,
    onDropOnDay: (id, day) => {
      const publication = data?.publications.find((p) => p.id === id);
      if (!publication?.scheduledFor) return;
      const to = moveToDay(publication.scheduledFor, day);
      if (to.getTime() !== new Date(publication.scheduledFor).getTime()) void move(publication, to);
    },
  };

  return (
    <>
      <PageHeader
        eyebrow={tn('manage')}
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button asChild>
              <Link href="/plans/new">
                <CalendarRange /> {t('planMonth')}
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/publications">
                <List /> {t('allPublications')}
              </Link>
            </Button>
          </>
        }
      />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2
          className="flex items-center gap-2 font-display text-3xl leading-none"
          aria-live="polite"
        >
          {title}
          {isValidating && !isLoading && (
            <Loader2
              aria-label={t('refreshing')}
              className="size-4 animate-spin text-muted-foreground"
            />
          )}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label={t('previousMonth')}
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            <ChevronLeft className="rtl:-scale-x-100" />
          </Button>
          <Button variant="outline" onClick={() => setMonth(monthOf(new Date()))}>
            {t('today')}
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('nextMonth')}
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            <ChevronRight className="rtl:-scale-x-100" />
          </Button>
        </div>
      </div>

      <MonthAheadSummary upcoming={summary.data?.upcoming ?? undefined} />
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-[32rem] rounded-xl" />}
      {data && (
        <>
          {data.truncated && (
            <p role="status" className="mb-3 text-xs text-muted-foreground">
              {t.rich('truncated', {
                count: MAX_PAGES * PAGE_LIMIT,
                link: (chunks) => (
                  <Link href="/publications" className="underline underline-offset-2">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
          <MonthGrid
            days={days}
            month={month}
            byDay={byDay}
            openByDay={openByDay}
            plannedByDay={plannedByDay}
            today={today}
            move={moveHandlers}
          />
          <AgendaList
            days={days}
            month={month}
            byDay={byDay}
            openByDay={openByDay}
            plannedByDay={plannedByDay}
            today={today}
            move={moveHandlers}
          />
          <p className="mt-4 text-xs text-muted-foreground">{t('dragHint')}</p>
          {openByDay.size > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{t('open.legend')}</p>
          )}
          {plannedByDay.size > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">{t('planned.legend')}</p>
          )}
          <MoveToDialog
            key={moving?.id ?? 'none'}
            publication={moving}
            onClose={() => setMoving(null)}
            onMove={move}
          />
        </>
      )}
      <DripQueuePanel onSaved={refreshSlots} />
    </>
  );
}
