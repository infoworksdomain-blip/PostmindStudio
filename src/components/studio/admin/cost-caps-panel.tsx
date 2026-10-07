'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { ErrorState, Section } from '../primitives';
import { useProjectName } from '@/lib/client/use-project-name';

// Spec 12.5 / 16.4 — spend today (and this month) against every cap, plus the recent cost
// alerts (GET /admin/cost/caps). Cap values are the operator's defaults in code (cost/caps.ts),
// overridable per environment (STUDIO_*_CAP_PENCE; "none" disables a cap).

const SCOPES = [
  'PROJECT',
  'ORG_DAILY',
  'ORG_MONTHLY',
  'ORG_PROVIDER_DAILY',
  'GLOBAL_DAILY',
] as const;
type AlertScope = (typeof SCOPES)[number];
/** custom = caps built without costCapsFromEnv (never in production). */
type CapSource = 'default' | 'env' | 'disabled' | 'custom';

export interface CostCapsResponse {
  ok: true;
  day: string;
  month: string;
  caps: {
    globalDaily: { capPence: number | null; spentPence: number; percent: number | null };
    orgDailyByTier: Record<string, number | null>;
    orgMonthlyByTier: Record<string, number | null>;
    orgProviderDaily: number | null;
    sources: {
      globalDaily: CapSource;
      orgDailyByTier: Record<string, CapSource>;
      orgMonthlyByTier: Record<string, CapSource>;
    };
    projectPausePercent: number;
  };
  organisationsThisMonth: Array<{ organisationId: string; spentPence: number }>;
  /** 13.19 per-organisation overrides (source org_override); absent in older responses. */
  orgOverrides?: Array<{
    organisationId: string;
    dailyPence: number | null;
    monthlyPence: number | null;
    source: 'org_override';
    reason: string;
    updatedAt: string;
  }>;
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

/** Projects created without a budget (cost/caps.ts): short-form and long-form defaults. */
const DEFAULT_SHORT_BUDGET_PENCE = 350;
const DEFAULT_LONG_BUDGET_PENCE = 3_000;
const PERCENT = 100;

/** "No cap" or the cap in the reader's locale. */
function useCapText(): (pence: number | null | undefined) => string {
  const t = useTranslations('admin.cost.caps');
  const f = useFormat();
  return (pence) => (pence === null || pence === undefined ? t('noCap') : f.pence(pence));
}

const SOURCE_TONE: Record<CapSource, StatusTone> = {
  default: 'neutral',
  custom: 'neutral',
  env: 'info',
  disabled: 'warn',
};

function SourceTag({ source }: { source: CapSource | undefined }) {
  const t = useTranslations('admin.cost.caps.source');
  if (!source) return null;
  return (
    <StatusPill tone={SOURCE_TONE[source]} size="sm" className="ms-1.5 align-middle">
      {t(source)}
    </StatusPill>
  );
}

function TierCaps({ caps }: { caps: CostCapsResponse['caps'] }) {
  const t = useTranslations('admin.cost.caps');
  const capText = useCapText();
  const columns: DataTableColumn<string>[] = [
    {
      id: 'tier',
      header: t('tierCol'),
      className: 'font-medium capitalize',
      cell: (tier) => tier.toLowerCase(),
    },
    {
      id: 'daily',
      header: t('dailyCol'),
      className: 'tabular-nums',
      cell: (tier) => (
        <>
          {capText(caps.orgDailyByTier[tier])}
          <SourceTag source={caps.sources.orgDailyByTier[tier]} />
        </>
      ),
    },
    {
      id: 'monthly',
      header: t('monthlyCol'),
      className: 'tabular-nums',
      cell: (tier) => (
        <>
          {capText(caps.orgMonthlyByTier[tier])}
          <SourceTag source={caps.sources.orgMonthlyByTier[tier]} />
        </>
      ),
    },
  ];
  return (
    <DataTable
      dense
      caption={t('tierTableAria')}
      columns={columns}
      rows={Object.keys(caps.orgDailyByTier)}
      getRowId={(tier) => tier}
    />
  );
}

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
          percent >= 100 ? 'bg-destructive' : percent >= 80 ? 'bg-warning' : 'bg-primary',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function CostCapsPanel() {
  const t = useTranslations('admin.cost.caps');
  const f = useFormat();
  const projectName = useProjectName();
  const capText = useCapText();
  const { data, error, isLoading, mutate } = useApi<CostCapsResponse>('/admin/cost/caps');
  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data?.caps) {
    return <Skeleton aria-label={t('loading')} className="h-40 rounded-xl" />;
  }
  const { caps } = data;
  const percent = (n: number) => f.percent(n / PERCENT);
  const projectPercent = (n: number | null) => (n === null ? f.date(null) : percent(n));
  const scopeLabel = (scope: string) =>
    (SCOPES as readonly string[]).includes(scope) ? t(`scope.${scope as AlertScope}`) : scope;
  return (
    <Section title={t('title', { day: data.day })}>
      <div className="grid gap-6">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <dt className="text-xs text-muted-foreground">{t('globalDaily')}</dt>
            <dd className="text-sm font-medium">
              {t('spentOfCap', {
                spent: f.pence(caps.globalDaily.spentPence),
                cap: capText(caps.globalDaily.capPence),
              })}
              <SourceTag source={caps.sources.globalDaily} />
              {/* Inside the dd: a dl may hold only dt / dd groups (axe definition-list). */}
              <div className="mt-1.5">
                <Meter percent={caps.globalDaily.percent} label={t('globalMeterAria')} />
              </div>
            </dd>
          </div>
          <div className="grid gap-1.5">
            <dt className="text-xs text-muted-foreground">{t('orgProviderDaily')}</dt>
            <dd className="text-sm font-medium">{capText(caps.orgProviderDaily)}</dd>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t('orgByTier')}</dt>
            <dd>
              <TierCaps caps={caps} />
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {t('explainer', {
            percent: percent(caps.projectPausePercent),
            shortBudget: f.pence(DEFAULT_SHORT_BUDGET_PENCE),
            longBudget: f.pence(DEFAULT_LONG_BUDGET_PENCE),
          })}
        </p>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('topToday')}</h3>
            {data.organisations.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noSpendToday')}</p>
            ) : (
              <ul aria-label={t('spendTodayAria')} className="grid gap-1.5 text-sm">
                {data.organisations.slice(0, 10).map((o) => (
                  <li key={o.organisationId} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-xs">{o.organisationId}</span>
                    <span>{f.pence(o.spentPence)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('topMonth', { month: data.month })}</h3>
            {data.organisationsThisMonth.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noSpendMonth')}</p>
            ) : (
              <ul aria-label={t('spendMonthAria')} className="grid gap-1.5 text-sm">
                {data.organisationsThisMonth.slice(0, 10).map((o) => (
                  <li key={o.organisationId} className="flex justify-between gap-2">
                    <span className="truncate font-mono text-xs">{o.organisationId}</span>
                    <span>{f.pence(o.spentPence)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('projectsNear')}</h3>
            {data.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('projectsNone')}</p>
            ) : (
              <ul aria-label={t('projectsAria')} className="grid gap-1.5 text-sm">
                {data.projects.slice(0, 10).map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <Link href={`/projects/${p.id}`} className="truncate hover:underline">
                      {projectName(p.name)}
                    </Link>
                    <span className={cn(p.paused && 'text-destructive')}>
                      {p.paused
                        ? t('projectPaused', { percent: projectPercent(p.percent) })
                        : projectPercent(p.percent)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {(data.orgOverrides?.length ?? 0) > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-semibold">{t('overrides')}</h3>
            <ul aria-label={t('overridesAria')} className="grid gap-1.5 text-sm">
              {data.orgOverrides?.map((o) => (
                <li key={o.organisationId} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className="font-mono text-xs">{o.organisationId}</span>
                    <StatusPill tone="info" size="sm" className="ms-1.5 align-middle">
                      {t('overrideTag')}
                    </StatusPill>
                  </span>
                  <span className="text-muted-foreground">
                    {t('overrideDetail', {
                      daily: capText(o.dailyPence),
                      monthly: capText(o.monthlyPence),
                      reason: o.reason,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">{t('alerts')}</h3>
          {data.recentAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noAlerts')}</p>
          ) : (
            <ul aria-label={t('alertsAria')} className="grid gap-1.5 text-sm">
              {data.recentAlerts.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    <span className={cn('font-medium', a.threshold >= 100 && 'text-destructive')}>
                      {percent(a.threshold)}
                    </span>{' '}
                    {scopeLabel(a.scope)} · <span className="font-mono text-xs">{a.scopeId}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {t('alertSpend', {
                      spent: f.pence(a.spentPence),
                      cap: f.pence(a.capPence),
                      when: f.relative(a.createdAt),
                    })}
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
