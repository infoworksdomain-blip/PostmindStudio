'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState } from '../primitives';
import { engagementRate, engagementTotal, leadingPlatform } from './analytics-model';
import type { OverviewResponse } from './types';

// BACKLOG 25.11 — the top of the analytics page: one plain sentence that sums up the period, then
// the four headline numbers (views, watch time, engagement rate, shares and saves). Totals come
// from each publication's latest snapshot (services/analytics.ts), so they cover the posts that
// went out in the window; no change against a previous period is shown here because the API
// reports no previous-period totals (the trend sections compare activity instead).

export { engagementRate, engagementTotal };

export interface OverviewState {
  data?: OverviewResponse;
  error?: unknown;
  isLoading: boolean;
  retry: () => void;
}

function Headline({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-2 font-display text-4xl leading-none tracking-tight md:text-[2.75rem]">
        {value}
      </dd>
      {hint && <dd className="mt-2 text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** Same footprint as the loaded summary, so nothing shifts when the numbers arrive. */
export function OverviewSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy aria-label={label} role="status">
      <Skeleton className="h-7 w-full max-w-2xl" />
      <Skeleton className="mt-2 h-7 w-2/3 max-w-xl" />
      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-border pt-6 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-10 w-28" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Summary({ data }: { data: OverviewResponse }) {
  const t = useTranslations('analytics.overview');
  const f = useFormat();
  const { totals, publications, days } = data;
  const rate = engagementRate(totals);
  const lead = leadingPlatform(data.byPlatform);
  return (
    <p className="max-w-3xl font-display text-xl leading-snug text-balance md:text-2xl">
      {rate === null
        ? t('summaryNoViews', { posts: publications, days })
        : t('summary', {
            posts: publications,
            days,
            count: totals.views,
            views: f.count(totals.views),
            rate: f.percent(rate, 1),
          })}{' '}
      {lead && (
        <span className="text-foreground-secondary">
          {t('summaryLead', { platform: f.platform(lead.platform), share: f.percent(lead.share) })}
        </span>
      )}
    </p>
  );
}

export function OverviewStrip({ overview }: { overview: OverviewState }) {
  const t = useTranslations('analytics.overview');
  const tf = useTranslations('format');
  const f = useFormat();
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.retry} />;
  if (overview.isLoading || !overview.data) return <OverviewSkeleton label={t('loadingAria')} />;

  const { totals, publications, projectsCreated, days } = overview.data;
  if (publications === 0)
    return (
      <EmptyState
        size="compact"
        media="publications"
        className="border-y border-border"
        title={t('empty.title', { days })}
        description={t('empty.body')}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/projects">{t('empty.action')}</Link>
          </Button>
        }
      />
    );

  const rate = engagementRate(totals);
  // Under a second a view rounds to "0s", which says nothing: leave the hint out.
  const perView = totals.views > 0 ? totals.watchTimeSec / totals.views : 0;
  return (
    <section aria-label={t('regionLabel')}>
      <Summary data={overview.data} />
      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-border pt-6 lg:grid-cols-4">
        <Headline
          label={t('views')}
          value={f.count(totals.views)}
          hint={t('viewsHint', { publications, projects: projectsCreated })}
        />
        <Headline
          label={t('watchTime')}
          value={f.duration(totals.watchTimeSec)}
          hint={perView >= 1 ? t('watchTimeHint', { avg: f.duration(perView) }) : undefined}
        />
        <Headline
          label={t('engagementRate')}
          value={rate === null ? tf('none') : f.percent(rate, 1)}
          hint={t('engagementHint', { count: f.count(engagementTotal(totals)) })}
        />
        <Headline
          label={t('sharesSaves')}
          value={f.count(totals.shares + totals.saves)}
          hint={t('sharesSavesHint', {
            shares: f.count(totals.shares),
            saves: f.count(totals.saves),
          })}
        />
      </dl>
      <p className="sr-only">{t('windowNote', { days })}</p>
    </section>
  );
}
