'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { formatPence } from '@/lib/client/format';
import { ErrorState, Section } from '../primitives';
import { AreaChart } from './area-chart';
import { BarList } from './bar-list';
import { shortDay } from './chart-utils';
import type { CostResponse } from './types';

// Spend (GET /analytics/cost?days) — provider-job ledger by day, provider and project.

/** Fill the days the ledger has no rows for, so the chart shows quiet days as zero. */
export function fillDays(
  byDay: CostResponse['byDay'],
  days: number,
  now: number = Date.now(),
): Array<{ day: string; costPence: number }> {
  const known = new Map(byDay.map((d) => [d.day, d.costPence]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, costPence: known.get(day) ?? 0 });
  }
  return out;
}

export function CostSection({
  days,
  data,
  error,
  isLoading,
  retry,
}: {
  days: number;
  data?: CostResponse;
  error?: unknown;
  isLoading: boolean;
  retry: () => void;
}) {
  if (error)
    return (
      <Section title="Spend">
        <ErrorState error={error} onRetry={retry} />
      </Section>
    );
  if (isLoading || !data)
    return (
      <Section title="Spend">
        <Skeleton className="h-48 rounded-lg" />
      </Section>
    );

  const points = fillDays(data.byDay, days).map((d) => ({
    label: shortDay(d.day),
    value: d.costPence,
  }));
  return (
    <Section
      title="Spend"
      description={`${formatPence(data.totalPence)} on AI providers in the last ${days} days`}
    >
      <AreaChart
        points={points}
        label={`Provider spend per day, last ${days} days`}
        formatValue={formatPence}
        minMax={100}
        color="var(--chart-2)"
        height={140}
      />
      <div className="mt-8 grid gap-8 md:grid-cols-2">
        <div>
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">By provider</h3>
          <BarList
            label="Spend by provider"
            empty="No provider jobs in this window."
            tone="var(--chart-2)"
            rows={data.byProvider.map((p) => ({
              key: p.provider,
              label: p.provider,
              value: p.costPence,
              display: formatPence(p.costPence),
              hint: `${p.jobs} job${p.jobs === 1 ? '' : 's'}`,
            }))}
          />
        </div>
        <div>
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">By project</h3>
          <BarList
            label="Spend by project"
            empty="No project spend in this window."
            tone="var(--chart-1)"
            rows={data.byProject.slice(0, 8).map((p) => ({
              key: p.projectId ?? 'none',
              label: p.projectId ? (
                <Link
                  href={`/projects/${p.projectId}`}
                  className="font-mono text-xs hover:underline"
                >
                  {p.projectId}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not tied to a project</span>
              ),
              value: p.costPence,
              display: formatPence(p.costPence),
            }))}
          />
        </div>
      </div>
    </Section>
  );
}
