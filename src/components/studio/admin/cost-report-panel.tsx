'use client';

import { useState, type FormEvent } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/client/api';
import { formatCount, formatPence } from '@/lib/client/format';
import { ErrorState, Section, Stat } from '../primitives';
import { AreaChart } from '../analytics/area-chart';
import { BarList } from '../analytics/bar-list';
import { shortDay } from '../analytics/chart-utils';
import { Segmented } from '../analytics/segmented';
import type { AdminCostResponse, AdminCostRow } from './types';
import { CostCapsPanel } from './cost-caps-panel';

// Spec 16.4 — platform cost dashboard (GET /admin/cost?days&organisationId): per organisation,
// per provider and per day, from the provider_usage rollup; caps + alerts above it (12.5).

const WINDOWS = [7, 30, 90] as const;

interface Rollup {
  totalPence: number;
  jobs: number;
  failed: number;
  byDay: Array<{ day: string; costPence: number }>;
  byOrg: Array<{ key: string; costPence: number; jobs: number }>;
  byProvider: Array<{ key: string; costPence: number; jobs: number; failed: number }>;
}

export function rollup(rows: AdminCostRow[]): Rollup {
  const day = new Map<string, number>();
  const org = new Map<string, { costPence: number; jobs: number }>();
  const provider = new Map<string, { costPence: number; jobs: number; failed: number }>();
  let totalPence = 0;
  let jobs = 0;
  let failed = 0;
  for (const r of rows) {
    totalPence += r.costPence;
    jobs += r.jobs;
    failed += r.failed;
    day.set(r.day, (day.get(r.day) ?? 0) + r.costPence);
    const o = org.get(r.organisationId) ?? { costPence: 0, jobs: 0 };
    org.set(r.organisationId, { costPence: o.costPence + r.costPence, jobs: o.jobs + r.jobs });
    const p = provider.get(r.provider) ?? { costPence: 0, jobs: 0, failed: 0 };
    provider.set(r.provider, {
      costPence: p.costPence + r.costPence,
      jobs: p.jobs + r.jobs,
      failed: p.failed + r.failed,
    });
  }
  const desc = <T extends { costPence: number }>(a: T, b: T) => b.costPence - a.costPence;
  return {
    totalPence,
    jobs,
    failed,
    byDay: [...day.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, costPence]) => ({ day: d, costPence })),
    byOrg: [...org.entries()].map(([key, v]) => ({ key, ...v })).sort(desc),
    byProvider: [...provider.entries()].map(([key, v]) => ({ key, ...v })).sort(desc),
  };
}

export function CostReportPanel() {
  const [days, setDays] = useState<number>(30);
  const [orgDraft, setOrgDraft] = useState('');
  const [organisationId, setOrganisationId] = useState('');
  const { data, error, isLoading, mutate } = useApi<AdminCostResponse>('/admin/cost', {
    days,
    organisationId: organisationId || undefined,
  });
  const r = data ? rollup(data.data) : null;

  const applyOrg = (e: FormEvent) => {
    e.preventDefault();
    setOrganisationId(orgDraft.trim());
  };

  return (
    <div className="grid gap-6">
      <CostCapsPanel />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form
          onSubmit={applyOrg}
          aria-label="Filter by organisation"
          className="flex items-end gap-2"
        >
          <div className="grid gap-1.5">
            <label htmlFor="cost-org" className="text-sm font-medium">
              Organisation
            </label>
            <Input
              id="cost-org"
              value={orgDraft}
              onChange={(e) => setOrgDraft(e.target.value)}
              placeholder="All organisations"
              className="w-56 max-w-full font-mono"
            />
          </div>
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>
        <Segmented
          label="Cost window"
          value={days}
          onChange={setDays}
          options={WINDOWS.map((d) => ({ value: d, label: `${d} days` }))}
        />
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label="Loading cost report" className="h-64 rounded-xl" />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-6 border-y border-border/70 py-5 sm:grid-cols-4">
            <Stat label="Provider spend" value={formatPence(r.totalPence)} />
            <Stat label="Jobs" value={formatCount(r.jobs)} />
            <Stat
              label="Failed jobs"
              value={formatCount(r.failed)}
              hint={r.jobs ? `${((r.failed / r.jobs) * 100).toFixed(1)}% of jobs` : undefined}
            />
            <Stat label="Organisations" value={formatCount(r.byOrg.length)} />
          </div>
          <Section title="Spend per day">
            {r.byDay.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No provider usage in this window.
              </p>
            ) : (
              <AreaChart
                points={r.byDay.map((d) => ({ label: shortDay(d.day), value: d.costPence }))}
                label={`Platform provider spend per day, last ${days} days`}
                formatValue={formatPence}
                color="var(--chart-2)"
                height={160}
              />
            )}
          </Section>
          <div className="grid gap-6 md:grid-cols-2">
            <Section title="By organisation">
              <BarList
                label="Spend by organisation"
                empty="No usage."
                tone="var(--chart-1)"
                rows={r.byOrg.slice(0, 15).map((o) => ({
                  key: o.key,
                  label: <span className="font-mono text-xs">{o.key}</span>,
                  value: o.costPence,
                  display: formatPence(o.costPence),
                  hint: `${formatCount(o.jobs)} jobs`,
                }))}
              />
            </Section>
            <Section title="By provider">
              <BarList
                label="Spend by provider"
                empty="No usage."
                tone="var(--chart-2)"
                rows={r.byProvider.map((p) => ({
                  key: p.key,
                  label: p.key,
                  value: p.costPence,
                  display: formatPence(p.costPence),
                  hint: `${formatCount(p.jobs)} jobs${p.failed ? ` · ${p.failed} failed` : ''}`,
                }))}
              />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
