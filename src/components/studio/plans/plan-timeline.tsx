'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { groupByWeek, type PlanItem } from './plan-model';

// BACKLOG 25.9 — a month plan as a timeline: one section per plan week ("Week 1 · 1–7 Oct ·
// 7 posts"), its days on a quiet rail, each day's posts as cards (rendered by the caller, an
// <li> each). Used by the draft editor and the running plan.

export function PlanTimeline({
  items,
  timezone,
  startDate,
  label,
  renderItem,
}: {
  items: readonly PlanItem[];
  timezone: string;
  startDate: string;
  label: string;
  renderItem: (item: PlanItem) => ReactNode;
}) {
  const t = useTranslations('plans.timeline');
  const f = useFormat();
  const day = (key: string, options: Intl.DateTimeFormatOptions) =>
    f.date(`${key}T12:00:00Z`, { ...options, timeZone: 'UTC' });
  return (
    <ol aria-label={label} className="flex flex-col gap-10">
      {groupByWeek(items, timezone, startDate).map((week) => {
        const id = `plan-week-${week.index}`;
        return (
          <li key={week.index} aria-labelledby={id} className="flex flex-col gap-4">
            <h3 id={id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-lg font-semibold tracking-tight">
                {t('week', { n: week.index })}
              </span>
              <span className="text-sm text-muted-foreground">
                {t('range', {
                  start: day(week.start, { day: 'numeric', month: 'short' }),
                  end: day(week.end, { day: 'numeric', month: 'short' }),
                })}
              </span>
            </h3>
            <ol className="ms-1.5 flex flex-col gap-6 border-s border-border ps-5">
              {week.days.map(({ day: key, items: dayItems }) => (
                <li key={key} className="relative flex flex-col gap-2">
                  <span
                    aria-hidden
                    className="absolute -start-[1.625rem] top-1 size-2.5 rounded-full border-2 border-background bg-border-strong"
                  />
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {day(key, { weekday: 'long', day: 'numeric', month: 'long' })}
                  </h4>
                  <ul className="flex flex-col gap-2">{dayItems.map(renderItem)}</ul>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ol>
  );
}
