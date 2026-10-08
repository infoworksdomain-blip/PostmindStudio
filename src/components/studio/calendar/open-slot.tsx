'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { formatTime } from './month';
import type { UpcomingSlots } from './use-upcoming-slots';

// 20.3 — an open drip-queue slot on the calendar: a posting time with no video yet. Dashed,
// muted and not interactive, so it is never mistaken for a real post; screen readers hear
// "Open posting time at 12:30, no video booked yet".

export function OpenSlot({ at, compact = false }: { at: string; compact?: boolean }) {
  const t = useTranslations('calendar.open');
  const f = useFormat();
  const time = formatTime(at, f.locale);
  return (
    <p
      data-open-slot={at}
      className={cn(
        'min-w-0 rounded-sm border border-dashed border-muted-foreground/40 text-muted-foreground',
        compact ? 'px-1.5 py-0.5 text-[0.7rem] leading-tight' : 'px-3 py-2 text-sm',
      )}
    >
      <span className="sr-only">{t('aria', { time })}</span>
      <span aria-hidden className="flex items-baseline gap-1.5">
        <span className="tabular shrink-0">{time}</span>
        <span className="truncate italic">{t('label')}</span>
      </span>
    </p>
  );
}

/** "Next 30 days: 12 posts scheduled · 8 open slots" (or how to turn the queue on). */
export function MonthAheadSummary({
  upcoming,
  onSetTimes,
}: {
  upcoming: UpcomingSlots | undefined;
  /** 25.9: opens the "Posting times" sheet. */
  onSetTimes: () => void;
}) {
  const t = useTranslations('calendar.summary');
  if (!upcoming) return null;
  const scheduled = upcoming.scheduled;
  return (
    <p className="text-sm text-muted-foreground">
      {upcoming.enabled
        ? t('next', { scheduled, open: upcoming.openSlots.length })
        : t.rich('queueOff', {
            scheduled,
            // A button, not a #fragment link: the demo build routes on the URL hash.
            link: (chunks) => (
              <button
                type="button"
                onClick={onSetTimes}
                aria-haspopup="dialog"
                className="text-foreground underline underline-offset-2"
              >
                {chunks}
              </button>
            ),
          })}
    </p>
  );
}
