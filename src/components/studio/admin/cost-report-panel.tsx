'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section, Stat } from '../primitives';
import { AreaChart, useShortDay } from '../analytics/area-chart';
import { BarList } from '../analytics/bar-list';
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
  const t = useTranslations('admin.cost.report');
  const tc = useTranslations('common.actions');
  const f = useFormat();
  const shortDay = useShortDay();
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
    <div className="grid gap-10">
      <CostCapsPanel />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form onSubmit={applyOrg} aria-label={t('orgFilterAria')} className="flex items-end gap-2">
          <div className="grid gap-1.5">
            <label htmlFor="cost-org" className="text-sm font-medium">
              {t('organisation')}
            </label>
            <Input
              id="cost-org"
              value={orgDraft}
              onChange={(e) => setOrgDraft(e.target.value)}
              placeholder={t('organisationPlaceholder')}
              className="w-56 max-w-full font-mono"
            />
          </div>
          <Button type="submit" variant="outline">
            {tc('apply')}
          </Button>
        </form>
        <SegmentedControl
          label={t('windowLabel')}
          value={days}
          onChange={setDays}
          options={WINDOWS.map((d) => ({ value: d, label: t('windowDays', { count: d }) }))}
        />
      </div>

      {error && <ErrorState error={error} onRetry={() => void mutate()} />}
      {isLoading && <Skeleton aria-label={t('loading')} className="h-64 rounded-xl" />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-6 border-y border-border/70 py-5 sm:grid-cols-4">
            <Stat label={t('spend')} value={f.pence(r.totalPence)} />
            <Stat label={t('jobs')} value={f.count(r.jobs)} />
            <Stat
              label={t('failedJobs')}
              value={f.count(r.failed)}
              hint={
                r.jobs
                  ? t('failedShare', {
                      percent: f.number(r.failed / r.jobs, {
                        style: 'percent',
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }),
                    })
                  : undefined
              }
            />
            <Stat label={t('organisations')} value={f.count(r.byOrg.length)} />
          </div>
          <Section title={t('perDay')}>
            {r.byDay.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">{t('noUsageWindow')}</p>
            ) : (
              <AreaChart
                points={r.byDay.map((d) => ({
                  label: shortDay(d.day),
                  value: d.costPence,
                }))}
                label={t('chartAria', { count: days })}
                formatValue={f.pence}
                color="var(--chart-2)"
                height={160}
              />
            )}
          </Section>
          <div className="grid gap-x-8 gap-y-10 md:grid-cols-2">
            <Section title={t('byOrg')}>
              <BarList
                label={t('byOrgAria')}
                empty={t('noUsage')}
                tone="var(--chart-1)"
                rows={r.byOrg.slice(0, 15).map((o) => ({
                  key: o.key,
                  label: <span className="font-mono text-xs">{o.key}</span>,
                  value: o.costPence,
                  display: f.pence(o.costPence),
                  hint: t('jobCount', { count: o.jobs }),
                }))}
              />
            </Section>
            <Section title={t('byProvider')}>
              <BarList
                label={t('byProviderAria')}
                empty={t('noUsage')}
                tone="var(--chart-2)"
                rows={r.byProvider.map((p) => ({
                  key: p.key,
                  label: p.key,
                  value: p.costPence,
                  display: f.pence(p.costPence),
                  hint: [
                    t('jobCount', { count: p.jobs }),
                    p.failed ? t('failedCount', { count: p.failed }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
              />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
