'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { formatCount, formatDuration, formatPence } from '@/lib/client/format';
import { ErrorState, Stat } from '../primitives';
import type { CostResponse, OverviewResponse } from './types';

// Headline numbers for the window: views lead (largest), then watch time, engagement and
// spend. Totals come from each publication's latest snapshot (services/analytics.ts).

export function engagementTotal(t: OverviewResponse['totals']): number {
  return t.likes + t.comments + t.shares + t.saves;
}

export function engagementRate(t: OverviewResponse['totals']): string {
  if (t.views <= 0) return '—';
  return `${((engagementTotal(t) / t.views) * 100).toFixed(1)}%`;
}

export function OverviewStrip({
  overview,
  cost,
}: {
  overview: { data?: OverviewResponse; error?: unknown; isLoading: boolean; retry: () => void };
  cost: { data?: CostResponse; error?: unknown };
}) {
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.retry} />;
  if (overview.isLoading || !overview.data)
    return <Skeleton aria-label="Loading overview" className="h-36 rounded-xl" />;

  const { totals, publications, projectsCreated, days } = overview.data;
  return (
    <div className="grid gap-6 border-y border-border/70 py-6 md:grid-cols-[1.3fr_2fr] md:gap-10">
      <div>
        <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
          Views · last {days} days
        </p>
        <p className="tabular mt-2 font-display text-7xl leading-none md:text-8xl">
          {formatCount(totals.views)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          across {publications} {publications === 1 ? 'publication' : 'publications'} ·{' '}
          {projectsCreated} {projectsCreated === 1 ? 'project' : 'projects'} started
        </p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 self-end sm:grid-cols-4">
        <Stat label="Watch time" value={formatDuration(totals.watchTimeSec)} />
        <Stat
          label="Engagement"
          value={formatCount(engagementTotal(totals))}
          hint={`${engagementRate(totals)} of views`}
        />
        <Stat
          label="Shares"
          value={formatCount(totals.shares)}
          hint={`${formatCount(totals.saves)} saves`}
        />
        <Stat
          label="Spend"
          value={cost.data ? formatPence(cost.data.totalPence) : cost.error ? '—' : '…'}
          hint="provider costs"
        />
      </div>
    </div>
  );
}
