'use client';

import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useApi } from '@/lib/client/api';
import { useShowCosts } from '../account/use-show-costs';
import { useBusiness } from '../business-context';
import type { BusinessesResponse } from '../business-picker';
import { PageHeader } from '../primitives';
import { BestTimesSection } from './best-times-section';
import { ContentPerformance, PlatformBreakdown } from './breakdowns';
import { CostSection } from './cost-section';
import { EngagementSection } from './engagement-section';
import { OverviewSkeleton, OverviewStrip } from './overview-strip';
import { TrendSection } from './trend-section';
import { RANGE_DAYS, type CostResponse, type OverviewResponse } from './types';
import { useRangeParam } from './use-range-param';

// BACKLOG 25.11 (spec 14.3) — Analytics as a hierarchy, not a grid of cards: 1) a one-sentence
// summary and four headline numbers, 2) growth and reach, 3) engagement, 4) content performance,
// 5) platform comparison, 6) best posting times, 7) spend (platform staff only — operator decision
// 2026-10-04: customers never see it, and it is not even fetched for them).
//
// Scope: the business selected in the top bar (BusinessProvider) narrows every customer-facing
// number (?businessId= on overview, timeseries, leaderboard and best-times); with none selected the
// page says it covers all businesses. Spend stays organisation-wide, as before, and says so.
// The period (7/30/90 days) lives in the URL (?days=).

function useScopeLabel(businessId: string | null): string {
  const t = useTranslations('analytics.dashboard');
  const { data } = useApi<BusinessesResponse>(businessId ? '/businesses' : null, undefined, {
    shouldRetryOnError: false,
  });
  if (!businessId) return t('scopeAll');
  const name = data?.data.find((b) => b.id === businessId)?.name;
  return name ? t('scopeBusiness', { name }) : t('scopeSelected');
}

export function AnalyticsDashboard() {
  const t = useTranslations('analytics.dashboard');
  const [days, setDays] = useRangeParam();
  const { businessId, ready } = useBusiness();
  const scope = useScopeLabel(businessId);
  const overview = useApi<OverviewResponse>(
    ready ? '/analytics/overview' : null,
    { days, ...(businessId && { businessId }) },
    { keepPreviousData: true },
  );
  const showCosts = useShowCosts();
  const cost = useApi<CostResponse>(showCosts ? '/analytics/cost' : null, { days });

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={
          <>
            <span className="font-medium text-foreground">{scope}</span>
            <span aria-hidden className="mx-2 text-muted-foreground">
              ·
            </span>
            {t('window', { days })}
          </>
        }
        actions={
          <SegmentedControl
            label={t('rangeLabel')}
            value={days}
            onChange={setDays}
            options={RANGE_DAYS.map((d) => ({ value: d, label: t('rangeOption', { days: d }) }))}
          />
        }
      />
      {ready ? (
        <div className="grid min-w-0 gap-12">
          <OverviewStrip
            overview={{
              data: overview.data,
              error: overview.error,
              isLoading: overview.isLoading && !overview.data,
              retry: () => void overview.mutate(),
            }}
          />
          <TrendSection days={days} businessId={businessId} />
          <EngagementSection days={days} businessId={businessId} overview={overview.data} />
          <div className="grid min-w-0 gap-12 lg:grid-cols-[1.4fr_1fr] lg:gap-10">
            <ContentPerformance days={days} businessId={businessId} />
            <div className="grid min-w-0 content-start gap-12">
              <PlatformBreakdown overview={overview.data} />
              <BestTimesSection businessId={businessId} />
            </div>
          </div>
          {showCosts && (
            <CostSection
              days={days}
              data={cost.data}
              error={cost.error}
              isLoading={cost.isLoading}
              retry={() => void cost.mutate()}
              scopeNote={businessId ? t('costScope') : undefined}
            />
          )}
        </div>
      ) : (
        <OverviewSkeleton label={t('loadingAria')} />
      )}
    </>
  );
}
