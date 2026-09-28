'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Stat } from '../primitives';
import type { CostResponse, OverviewResponse } from './types';

// Headline numbers for the window: views lead (largest), then watch time, engagement and
// spend. Totals come from each publication's latest snapshot (services/analytics.ts).

export function engagementTotal(t: OverviewResponse['totals']): number {
  return t.likes + t.comments + t.shares + t.saves;
}

/** Engagement as a fraction of views (0.032 = 3.2 %); null when nothing was viewed. */
export function engagementRate(t: OverviewResponse['totals']): number | null {
  if (t.views <= 0) return null;
  return engagementTotal(t) / t.views;
}

export function OverviewStrip({
  overview,
  cost,
}: {
  overview: { data?: OverviewResponse; error?: unknown; isLoading: boolean; retry: () => void };
  cost: { data?: CostResponse; error?: unknown };
}) {
  const t = useTranslations('analytics.overview');
  const tf = useTranslations('format');
  const f = useFormat();
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.retry} />;
  if (overview.isLoading || !overview.data)
    return <Skeleton aria-label={t('loadingAria')} className="h-36 rounded-xl" />;

  const { totals, publications, projectsCreated, days } = overview.data;
  const rate = engagementRate(totals);
  const spend = cost.data ? f.pence(cost.data.totalPence) : cost.error ? tf('none') : t('pending');
  return (
    <div className="grid gap-6 border-y border-border/70 py-6 md:grid-cols-[1.3fr_2fr] md:gap-10">
      <div>
        <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {t('viewsHeading', { days })}
        </p>
        <p className="tabular mt-2 font-display text-7xl leading-none md:text-8xl">
          {f.count(totals.views)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('summary', { publications, projects: projectsCreated })}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 self-end sm:grid-cols-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('watchTime')} value={f.duration(totals.watchTimeSec)} />
        <Stat
          label={t('engagement')}
          value={f.count(engagementTotal(totals))}
          hint={t('engagementHint', { rate: rate === null ? tf('none') : f.percent(rate, 1) })}
        />
        <Stat
          label={t('shares')}
          value={f.count(totals.shares)}
          hint={t('savesHint', { saves: totals.saves, formatted: f.count(totals.saves) })}
        />
        <Stat label={t('spend')} value={spend} hint={t('spendHint')} />
      </div>
    </div>
  );
}
