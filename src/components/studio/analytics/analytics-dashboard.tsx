'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApi } from '@/lib/client/api';
import { PageHeader } from '../primitives';
import { Leaderboard, PlatformBreakdown } from './breakdowns';
import { CostSection } from './cost-section';
import { OverviewStrip } from './overview-strip';
import { Segmented } from './segmented';
import { TrendSection } from './trend-section';
import { RANGE_DAYS, type CostResponse, type OverviewResponse, type RangeDays } from './types';

// BACKLOG 10.6 / spec 14.3 — Analytics: headline totals, daily trend, per-platform and
// per-publication breakdowns, and spend by provider/project over a 7/30/90-day window
// (the windows the overview, leaderboard and cost endpoints accept).

export function AnalyticsDashboard() {
  const t = useTranslations('analytics.dashboard');
  const [days, setDays] = useState<RangeDays>(30);
  const overview = useApi<OverviewResponse>('/analytics/overview', { days });
  const cost = useApi<CostResponse>('/analytics/cost', { days });

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={
          <Segmented
            label={t('rangeLabel')}
            value={days}
            onChange={setDays}
            options={RANGE_DAYS.map((d) => ({ value: d, label: t('rangeOption', { days: d }) }))}
          />
        }
      />
      <div className="grid min-w-0 gap-6">
        <OverviewStrip
          overview={{
            data: overview.data,
            error: overview.error,
            isLoading: overview.isLoading,
            retry: () => void overview.mutate(),
          }}
          cost={{ data: cost.data, error: cost.error }}
        />
        <TrendSection days={days} />
        <div className="grid min-w-0 gap-6 lg:grid-cols-[1fr_1.4fr]">
          <PlatformBreakdown overview={overview.data} />
          <Leaderboard days={days} />
        </div>
        <CostSection
          days={days}
          data={cost.data}
          error={cost.error}
          isLoading={cost.isLoading}
          retry={() => void cost.mutate()}
        />
      </div>
    </>
  );
}
