'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { browserTimeZone, rankedSlots, slotParts } from './analytics-model';
import { BarList } from './bar-list';
import type { BestTimesResponse } from './types';

// BACKLOG 25.11 — best posting times on the analytics page (until now only the publish panel
// showed them). GET /analytics/best-times (15.A6): each post of the last 180 days counts once, in
// the weekday and hour it went live in the viewer's time zone, scored by mean views relative to
// the best slot. Advisory only. With too little history the per-day suggestions (or the business's
// learned posting time) are shown and the note says so.

export function BestTimesSection({ businessId }: { businessId: string | null }) {
  const t = useTranslations('analytics.bestTimes');
  const f = useFormat();
  const timezone = browserTimeZone();
  const { data, error, isLoading, mutate } = useApi<BestTimesResponse>(
    '/analytics/best-times',
    { timezone, ...(businessId && { businessId }) },
    { keepPreviousData: true },
  );
  const slots = rankedSlots(data);

  return (
    <Section title={t('title')} description={t('description')}>
      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && !data && <Skeleton className="h-52 rounded-field" />}
      {data && slots.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {data && slots.length > 0 && (
        <>
          <BarList
            label={t('listLabel')}
            empty={t('empty')}
            rows={slots.map((s) => {
              const parts = slotParts(s, f);
              return {
                key: `${s.weekday}-${s.hour}`,
                label: t('slot', { day: parts.day, time: parts.time }),
                value: s.score,
                display: f.percent(s.score),
              };
            })}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            {data.sufficientData
              ? t('basis', { videos: data.videos, timezone: data.timezone })
              : data.styleMemory
                ? t('fromMemory', { timezone: data.timezone })
                : t('littleData', {
                    videos: data.videos,
                    min: data.minVideos,
                    timezone: data.timezone,
                  })}
          </p>
        </>
      )}
    </Section>
  );
}
