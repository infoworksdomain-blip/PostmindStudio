'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, List, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, PageHeader } from '../primitives';
import {
  dayKey,
  formatMonth,
  gridWindow,
  groupByDay,
  monthGrid,
  monthOf,
  shiftMonth,
} from './month';
import { AgendaList, MonthGrid } from './month-views';
import { MAX_PAGES, PAGE_LIMIT, useCalendarPublications } from './use-calendar-publications';

// BACKLOG 10.5 — Manage: calendar of scheduled and published videos (spec 14.3), from
// GET /publications with a from/to window. Month grid on desktop, agenda list on phones.

export function PublicationsCalendar({ initialDate }: { initialDate?: Date }) {
  const [month, setMonth] = useState(() => monthOf(initialDate ?? new Date()));
  const days = useMemo(() => monthGrid(month), [month]);
  const range = useMemo(() => gridWindow(month), [month]);
  const today = dayKey(new Date());
  const { data, error, isLoading, isValidating, mutate } = useCalendarPublications(
    range.from,
    range.to,
  );
  const byDay = useMemo(() => groupByDay(data?.publications ?? []), [data]);
  const title = formatMonth(month);

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Calendar"
        description="Scheduled and published videos across every platform."
        actions={
          <Button variant="outline" asChild>
            <Link href="/publications">
              <List /> All publications
            </Link>
          </Button>
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
              aria-label="Refreshing"
              className="size-4 animate-spin text-muted-foreground"
            />
          )}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
          >
            <ChevronLeft />
          </Button>
          <Button variant="outline" onClick={() => setMonth(monthOf(new Date()))}>
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading calendar" className="h-[32rem] rounded-xl" />}
      {data && (
        <>
          {data.truncated && (
            <p role="status" className="mb-3 text-xs text-muted-foreground">
              Showing the first {MAX_PAGES * PAGE_LIMIT} publications this month.{' '}
              <Link href="/publications" className="underline underline-offset-2">
                See them all
              </Link>
              .
            </p>
          )}
          <MonthGrid days={days} month={month} byDay={byDay} today={today} />
          <AgendaList days={days} month={month} byDay={byDay} today={today} />
          <p className="mt-4 text-xs text-muted-foreground">
            To reschedule, cancel the scheduled post and schedule it again from its project.
          </p>
        </>
      )}
    </>
  );
}
