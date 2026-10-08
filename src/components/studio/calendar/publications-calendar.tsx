'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarRange, Clock, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { useHydrated } from '@/lib/client/use-hydrated';
import type { Publication } from '@/lib/client/types';
import { ErrorState, PageHeader } from '../primitives';
import { LiveProjectsProvider } from '../live/live-projects-context';
import { CalendarFilterBar, CalendarToolbar } from './calendar-toolbar';
import { shiftAnchor, viewDays, viewTitle, viewWindow, type CalendarView } from './calendar-view';
import { dayKey, monthOf, moveToDay, zoneLabel } from './month';
import { MonthGrid } from './month-grid';
import { AgendaList, type MoveHandlers } from './month-views';
import { MonthAheadSummary } from './open-slot';
import { PostPanel, type PanelTarget } from './post-panel';
import { PostingTimesSheet } from './posting-times-sheet';
import { MoveToDialog, useReschedule } from './reschedule';
import { useRetryPublication } from './retry';
import { useCalendarData } from './use-calendar-data';
import { MAX_PAGES, PAGE_LIMIT } from './use-calendar-publications';
import { useCalendarUrl } from './use-calendar-url';
import { WeekView } from './week-view';

// BACKLOG 10.5 — Manage: calendar of scheduled and published videos (spec 14.3), from
// GET /publications with a from/to window. Scheduled posts can be dragged to another day or
// moved with the move dialog (13.9). 20.3: open drip-queue slots show as dashed markers with a
// "Next 30 days" summary. 24.2: posts open in a side panel with live status chips.
// 25.9: Month / Week / Day views over the same data (the view, day and filters live in the URL),
// a month ARIA grid with keyboard moves, "+n more" popovers, platform / status / source filters,
// Undo after a move, and the posting times in a side sheet instead of under the calendar.

/** Keeps the line's height while it waits for hydration (no layout shift). */
const PLACEHOLDER = ' ';

export function PublicationsCalendar({ initialDate }: { initialDate?: Date }) {
  const t = useTranslations('calendar');
  const tn = useTranslations('shell.nav.groups');
  const f = useFormat();
  const url = useCalendarUrl(initialDate);
  const { view, anchor, filters } = url;
  const month = monthOf(anchor);
  const days = viewDays(view, anchor);
  const range = viewWindow(view, anchor);
  const today = dayKey(new Date());
  const data = useCalendarData(range, filters);
  const { publications } = data;
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const [timesOpen, setTimesOpen] = useState(false);
  const [moving, setMoving] = useState<Publication | null>(null);
  const { move, pending, announcement } = useReschedule(() => void publications.mutate());
  const { retry, retrying } = useRetryPublication(() => void publications.mutate());
  // The period and the viewer's time zone are the browser's: the server renders in its own zone
  // (UTC in production), so both lines wait for hydration or a visitor elsewhere gets React
  // error #418 (hydration mismatch) on every calendar load.
  const hydrated = useHydrated();
  const title = hydrated ? viewTitle(view, anchor, f.locale) : PLACEHOLDER;
  const zoneLine = hydrated
    ? t('timeZone', { zone: zoneLabel(new Date(month.year, month.month, 15), f.locale) })
    : PLACEHOLDER;
  const moveHandlers: MoveHandlers = {
    onMove: setMoving,
    pendingId: pending,
    onRetry: (p) => void retry(p),
    retryingId: retrying,
    onOpen: (publication) => setPanel({ kind: 'publication', publication }),
    onOpenPlanned: (post) => setPanel({ kind: 'planned', post }),
    onDropOnDay: (id, day) => {
      const publication = publications.data?.publications.find((p) => p.id === id);
      if (!publication?.scheduledFor) return;
      const to = moveToDay(publication.scheduledFor, day);
      if (to.getTime() !== new Date(publication.scheduledFor).getTime()) void move(publication, to);
    },
  };
  const views = {
    byDay: data.byDay,
    openByDay: data.openByDay,
    plannedByDay: data.plannedByDay,
    today,
    move: moveHandlers,
  };
  const emptyText = t(
    view === 'month' ? 'grid.emptyMonth' : view === 'week' ? 'grid.emptyWeek' : 'grid.emptyDayView',
  );
  const openDay = (day: Date) => url.show('day', day);

  return (
    <LiveProjectsProvider value={data.live}>
      <PageHeader
        eyebrow={tn('plan')}
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button variant="outline" onClick={() => setTimesOpen(true)} aria-haspopup="dialog">
              <Clock /> {t('postingTimes.open')}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/publications">
                <List /> {t('allPublications')}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/plans/new">
                <CalendarRange /> {t('planMonth')}
              </Link>
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <CalendarToolbar
          title={title}
          view={view}
          refreshing={publications.isValidating && !publications.isLoading}
          onView={(next: CalendarView) => url.setView(next)}
          onShift={(delta) => url.setDate(shiftAnchor(view, anchor, delta))}
          onToday={() => url.setDate(null)}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <MonthAheadSummary
            upcoming={data.summary.data?.upcoming ?? undefined}
            onSetTimes={() => setTimesOpen(true)}
          />
          <CalendarFilterBar
            filters={filters}
            platforms={data.platforms}
            shown={data.shownCount}
            total={data.totalCount}
            onChange={url.setFilters}
            onClear={url.clearFilters}
          />
        </div>
        <p className="text-xs text-muted-foreground">{zoneLine}</p>
      </div>
      {publications.error && (
        <ErrorState error={publications.error} onRetry={() => void publications.mutate()} />
      )}
      {publications.isLoading && (
        <Skeleton aria-label={t('loading')} className="h-[32rem] rounded-panel" />
      )}
      {publications.data && (
        <>
          {publications.data.truncated && (
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
          {view === 'month' ? (
            <MonthGrid
              {...views}
              days={days}
              month={month}
              selected={url.date}
              onSelect={(day) => url.setDate(day)}
              onOpenDay={openDay}
              emptyText={emptyText}
            />
          ) : (
            <WeekView {...views} days={days} selected={url.date} onOpenDay={openDay} />
          )}
          <AgendaList
            {...views}
            days={days}
            inView={(d) => view !== 'month' || d.getMonth() === month.month}
            showEmptyDays={view !== 'month'}
            media={view !== 'month'}
            emptyText={emptyText}
          />
          <div className="mt-4 flex flex-col gap-1 text-xs text-muted-foreground">
            <p>{t('dragHint')}</p>
            {data.openByDay.size > 0 && <p>{t('open.legend')}</p>}
            {data.plannedByDay.size > 0 && <p>{t('planned.legend')}</p>}
          </div>
          <MoveToDialog
            key={moving?.id ?? 'none'}
            publication={moving}
            onClose={() => setMoving(null)}
            onMove={move}
          />
        </>
      )}
      {/* 25.9: moves and their undo, read out (the toast region is announced too). */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="calendar-live">
        {announcement}
      </p>
      <PostPanel
        target={panel}
        onClose={() => setPanel(null)}
        onReschedule={(publication) => {
          setPanel(null);
          setMoving(publication);
        }}
        onChanged={data.refresh}
      />
      <PostingTimesSheet open={timesOpen} onOpenChange={setTimesOpen} onSaved={data.refreshSlots} />
    </LiveProjectsProvider>
  );
}
