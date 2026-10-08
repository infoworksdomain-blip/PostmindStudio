'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { Section } from '../primitives';
import { engagementMix, engagementRate } from './analytics-model';
import { BarList } from './bar-list';
import { ChangeBadge } from './change-badge';
import { SeriesChart } from './series-chart';
import type { OverviewResponse } from './types';
import { useSeries } from './use-series';

// BACKLOG 25.11 — engagement: likes, comments, shares and saves gained per day (the timeseries'
// engagement metric) with the change against the previous period, and what the engagement on
// the period's posts was made of (overview totals).

const ENGAGEMENT_COLOR = 'var(--chart-4)';

export function EngagementSection({
  days,
  businessId,
  overview,
}: {
  days: number;
  businessId: string | null;
  overview?: OverviewResponse;
}) {
  const t = useTranslations('analytics.engagement');
  const f = useFormat();
  const series = useSeries('engagement', days, businessId);
  const rate = overview ? engagementRate(overview.totals) : null;
  const mix = overview ? engagementMix(overview.totals) : [];

  return (
    <Section
      title={t('title')}
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {series.change
              ? t('total', { value: f.count(series.change.current), days })
              : t('description')}
          </span>
          <ChangeBadge change={series.change} days={days} />
        </span>
      }
    >
      <div className="grid min-w-0 gap-8 lg:grid-cols-[1.6fr_1fr] lg:gap-10">
        <div className="min-w-0">
          <SeriesChart
            series={series}
            label={t('chartLabel', { days })}
            formatValue={f.count}
            color={ENGAGEMENT_COLOR}
            height={160}
            quiet={t('quiet', { days })}
          />
        </div>
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-muted-foreground">{t('mixTitle')}</h3>
          {overview ? (
            <>
              <p className="mt-1 mb-4 text-sm text-foreground-secondary">
                {rate === null ? t('mixNoViews') : t('mixRate', { rate: f.percent(rate, 1) })}
              </p>
              <BarList
                label={t('mixLabel')}
                empty={t('mixEmpty')}
                tone={ENGAGEMENT_COLOR}
                rows={mix
                  .filter((m) => m.value > 0)
                  .map((m) => ({
                    key: m.key,
                    label: t(`parts.${m.key}`),
                    value: m.value,
                    display: f.count(m.value),
                  }))}
              />
            </>
          ) : (
            <Skeleton className="mt-2 h-44 rounded-field" />
          )}
        </div>
      </div>
    </Section>
  );
}
