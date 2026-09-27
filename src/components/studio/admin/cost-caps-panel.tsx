'use client';

import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatPence, relativeTime } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { ErrorState, Section } from '../primitives';

// Spec 12.5 / 16.4 — spend today against every configured cap, plus the recent cost alerts
// (GET /admin/cost/caps). Caps are environment settings (STUDIO_*_CAP_PENCE); unset = no cap.

type AlertScope = 'PROJECT' | 'ORG_DAILY' | 'ORG_PROVIDER_DAILY' | 'GLOBAL_DAILY';

export interface CostCapsResponse {
  ok: true;
  day: string;
  caps: {
    globalDaily: { capPence: number | null; spentPence: number; percent: number | null };
    orgDailyByTier: Record<string, number | null>;
    orgProviderDaily: number | null;
    projectPausePercent: number;
  };
  organisations: Array<{
    organisationId: string;
    spentPence: number;
    providers: Array<{ provider: string; spentPence: number; percentOfCap: number | null }>;
  }>;
  projects: Array<{
    id: string;
    organisationId: string;
    name: string;
    state: string;
    costBudgetPence: number | null;
    costActualPence: number;
    percent: number | null;
    paused: boolean;
  }>;
  recentAlerts: Array<{
    id: string;
    scope: AlertScope;
    scopeId: string;
    organisationId: string | null;
    period: string;
    threshold: number;
    capPence: number;
    spentPence: number;
    createdAt: string;
  }>;
}

const SCOPE_LABEL: Record<AlertScope, string> = {
  PROJECT: 'Project budget',
  ORG_DAILY: 'Organisation daily',
  ORG_PROVIDER_DAILY: 'Organisation × provider daily',
  GLOBAL_DAILY: 'Global daily',
};

const capText = (pence: number | null | undefined) =>
  pence === null || pence === undefined ? 'No cap' : formatPence(pence);

function Meter({ percent, label }: { percent: number | null; label: string }) {
  if (percent === null) return null;
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full',
          percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-amber-500' : 'bg-primary',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function CostCapsPanel() {
  const { data, error, isLoading, mutate } = useApi<CostCapsResponse>('/admin/cost/caps');
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data?.caps) {
    return <Skeleton aria-label="Loading cost caps" className="h-40 rounded-xl" />;
  }
  const { caps } = data;
  return (
    <Section title={`Caps today (${data.day}, UTC)`}>
      <div className="grid gap-6">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <dt className="text-xs text-muted-foreground">Global daily</dt>
            <dd className="text-sm font-medium">
              {formatPence(caps.globalDaily.spentPence)} / {capText(caps.globalDaily.capPence)}
            </dd>
            <Meter percent={caps.globalDaily.percent} label="Global daily cap used" />
          </div>
          <div className="grid gap-1.5">
            <dt className="text-xs text-muted-foreground">Organisation × provider daily</dt>
            <dd className="text-sm font-medium">{capText(caps.orgProviderDaily)}</dd>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Organisation daily, by plan tier</dt>
            <dd className="text-sm font-medium">
              {Object.entries(caps.orgDailyByTier)
                .map(([tier, cap]) => `${tier.toLowerCase()} ${capText(cap)}`)
                .join(' · ')}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Projects pause at {caps.projectPausePercent}% of their budget; daily caps pause generation
          at 100% (publishing continues). Alerts fire once at 80% and 100% of each cap.
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">Top organisations today</h3>
            {data.organisations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No provider spend today.</p>
            ) : (
              <ul aria-label="Organisation spend today" className="grid gap-1.5 text-sm">
                {data.organisations.slice(0, 10).map((o) => (
                  <li key={o.organisationId} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-xs">{o.organisationId}</span>
                    <span>{formatPence(o.spentPence)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">Projects at or over 80% of budget</h3>
            {data.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">None in the last 7 days.</p>
            ) : (
              <ul aria-label="Projects near their budget" className="grid gap-1.5 text-sm">
                {data.projects.slice(0, 10).map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <Link href={`/projects/${p.id}`} className="truncate hover:underline">
                      {p.name}
                    </Link>
                    <span className={cn(p.paused && 'text-destructive')}>
                      {p.percent ?? '—'}%{p.paused ? ' · paused' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">Cost alerts, last 7 days</h3>
          {data.recentAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost alerts.</p>
          ) : (
            <ul aria-label="Recent cost alerts" className="grid gap-1.5 text-sm">
              {data.recentAlerts.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className={cn('font-medium', a.threshold >= 100 && 'text-destructive')}>
                      {a.threshold}%
                    </span>{' '}
                    {SCOPE_LABEL[a.scope]} · <span className="font-mono text-xs">{a.scopeId}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {formatPence(a.spentPence)} / {formatPence(a.capPence)} ·{' '}
                    {relativeTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}
