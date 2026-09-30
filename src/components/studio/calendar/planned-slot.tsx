'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { formatTime } from './month';
import type { PlannedPost } from './use-upcoming-slots';

// 20.9 — a month-plan post that is not a publication yet (waiting, generating, waiting for review
// or held by the safety check): a dashed box with its time and topic that links to its plan.
// Once scheduled it shows as the publication itself.

export function PlannedSlot({ post, compact = false }: { post: PlannedPost; compact?: boolean }) {
  const t = useTranslations('calendar.planned');
  const ts = useTranslations('plans.itemStatus');
  const f = useFormat();
  const time = formatTime(post.slotAt, f.locale);
  const status = ts(post.status);
  return (
    <Link
      href={`/plans/${post.planId}`}
      data-planned-slot={post.itemId}
      aria-label={t('aria', { time, title: post.title, status })}
      className={cn(
        'block min-w-0 rounded-sm border border-dashed border-primary/50 bg-primary/5 text-foreground hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
      )}
    >
      <span aria-hidden className="flex items-baseline gap-1.5">
        <span className="tabular shrink-0">{time}</span>
        <span className="shrink-0 text-primary">{t('label')}</span>
        <span className="truncate">{post.title}</span>
      </span>
    </Link>
  );
}

/** Planned posts by local day, in time order. */
export function groupPlannedByDay(
  posts: ReadonlyArray<PlannedPost>,
  dayKey: (d: Date) => string,
): Map<string, PlannedPost[]> {
  const byDay = new Map<string, PlannedPost[]>();
  for (const post of [...posts].sort((a, b) => a.slotAt.localeCompare(b.slotAt))) {
    const key = dayKey(new Date(post.slotAt));
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }
  return byDay;
}
