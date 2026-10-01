'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import {
  ALL_DAYS,
  maxPostsPerDay,
  previewTimes,
  sortDays,
  timesForDay,
  type DripSlot,
  type PostingSchedule,
} from '@/lib/studio/posting-schedule';
import { weekdayNames } from './month';
import { intervalParts } from './schedule-model';

// 20.14 — the schedule's one-line summary ("4 posts a day · every 3 hours from 09:00 ·
// Europe/London") and the "Next 7 days" list of resolved post times, shown in the schedule's
// own time zone (DST-correct: the times come from the shared resolver).

type T = ReturnType<typeof useTranslations<'calendar.drip.schedule'>>;

export function useScheduleSummary(): (s: PostingSchedule, slots: DripSlot[]) => string {
  const t = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const short = useMemo(() => weekdayNames(f.locale, 'short'), [f.locale]);
  return (s, slots) => summarise(t, f.list, short, s, slots);
}

function summarise(
  t: T,
  list: (items: string[]) => string,
  short: string[],
  s: PostingSchedule,
  slots: DripSlot[],
): string {
  if (s.mode === 'custom')
    return [t('summary.custom', { count: slots.length }), s.timezone].join(' · ');
  const days = sortDays(s.days);
  const parts: string[] = [];
  if (s.mode === 'daily') {
    parts.push(t('summary.perDay', { count: s.postsPerDay }));
    if (days.length < ALL_DAYS.length)
      parts.push(t('summary.onDays', { days: list(days.map((d) => short[d]!)) }));
  } else {
    parts.push(t('summary.perWeek', { count: s.postsPerWeek }));
    parts.push(t('summary.onDays', { days: list(days.map((d) => short[d]!)) }));
  }
  if (s.timesMode === 'interval' && s.intervalBy === 'user') {
    const p = intervalParts(s.intervalMinutes);
    const every =
      p.minutes === 0
        ? t('hours', { count: p.hours })
        : p.hours === 0
          ? t('minutes', { count: p.minutes })
          : t('hoursMinutes', { hours: p.hours, minutes: p.minutes });
    parts.push(t('summary.every', { interval: every, start: s.intervalStart }));
  } else if (s.timesMode === 'interval') {
    parts.push(t('summary.spread', { start: s.windowStart, end: s.windowEnd }));
  } else {
    parts.push(t('summary.at', { times: list(timesForDay(s, maxPostsPerDay(s))) }));
  }
  parts.push(s.timezone);
  return parts.join(' · ');
}

export function SchedulePreview({
  schedule,
  slots,
  now,
}: {
  schedule: PostingSchedule;
  slots: DripSlot[];
  /** Injected in tests; defaults to the current time. */
  now?: number;
}) {
  const t = useTranslations('calendar.drip.schedule');
  const f = useFormat();
  const summary = useScheduleSummary();
  const [openedAt] = useState(() => Date.now());
  const from = now ?? openedAt;
  const times = useMemo(() => (slots.length ? previewTimes(slots, from) : []), [slots, from]);
  const fmt = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(f.locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: schedule.timezone,
      });
    } catch {
      return new Intl.DateTimeFormat(f.locale, { dateStyle: 'medium', timeStyle: 'short' });
    }
  }, [f.locale, schedule.timezone]);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <p className="text-sm font-medium" aria-live="polite" data-testid="schedule-summary">
        {slots.length ? summary(schedule, slots) : t('summary.none')}
      </p>
      <h4 className="text-xs font-medium text-muted-foreground">{t('previewTitle')}</h4>
      {times.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('previewEmpty')}</p>
      ) : (
        <ul aria-label={t('previewTitle')} className="flex flex-wrap gap-1.5 text-xs">
          {times.map((at) => (
            <li key={at} className="tabular rounded bg-background px-2 py-1">
              <time dateTime={new Date(at).toISOString()}>{fmt.format(new Date(at))}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
