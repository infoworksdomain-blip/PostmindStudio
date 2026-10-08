'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill, type StatusTone } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, Section } from '../primitives';

// BACKLOG 13.16 / spec 16.4 — Admin Centre "Queue health" (GET /admin/queues) and "Provider
// health" (GET /admin/providers: shared Redis circuit breaker, error rate of the last hour,
// spend today). Both refresh every 30 s.

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  oldestWaitingSec: number | null;
}

export interface ProviderHealth {
  id: string;
  configured: boolean;
  breaker: 'closed' | 'open' | 'half_open';
  errorRate1h: number | null;
  jobs1h: { succeeded: number; failed: number; running: number };
  spendTodayPence: number;
  /** 20.11: held out of routing for an account problem (key, credits, usage limit). */
  accountHold?: { errorClass: string; reason: string; until: string; since: string } | null;
  healthy: boolean;
}

const HOLD_CLASSES = ['auth', 'insufficient_credits', 'account_limit'] as const;

/** 20.11: why the provider is held and until when; the provider's own message for staff. */
function AccountHoldNote({ hold }: { hold: NonNullable<ProviderHealth['accountHold']> }) {
  const t = useTranslations('admin.health.providers');
  const f = useFormat();
  const problem = (HOLD_CLASSES as readonly string[]).includes(hold.errorClass)
    ? t(`holdClass.${hold.errorClass as (typeof HOLD_CLASSES)[number]}`)
    : hold.errorClass;
  return (
    <div className="mt-1 max-w-md text-xs">
      <p className="font-medium text-destructive">
        {t('accountHold', {
          problem,
          until: f.date(hold.until, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }),
        })}
      </p>
      {hold.reason && (
        <p className="mt-0.5 break-words text-muted-foreground">
          <bdi dir="auto">{hold.reason}</bdi>
        </p>
      )}
    </div>
  );
}

const REFRESH_MS = 30_000;
/** A job waiting longer than this is worth a look (spec 11.3 queue latency targets are minutes). */
const SLOW_WAIT_SEC = 300;
const NONE = '—';
/** Counts, rates and money in Geist Mono with tabular figures. */
const MONO = 'font-mono text-xs';

function useWaitText(): (sec: number | null) => string {
  const t = useTranslations('admin.health.queues');
  const f = useFormat();
  return (sec) => {
    if (sec === null) return NONE;
    if (sec < 60) return t('waitSeconds', { seconds: f.number(sec) });
    if (sec < 3600)
      return t('waitMinutes', {
        minutes: f.number(Math.floor(sec / 60)),
        seconds: f.number(sec % 60),
      });
    return t('waitHours', {
      hours: f.number(Math.floor(sec / 3600)),
      minutes: f.number(Math.floor((sec % 3600) / 60)),
    });
  };
}

function Num({ value, warn }: { value: number; warn?: boolean }) {
  const f = useFormat();
  return (
    <span className={cn(warn && value > 0 && 'font-medium text-warning-foreground')}>
      {f.number(value)}
    </span>
  );
}

function Refresh({ onClick }: { onClick: () => void }) {
  const t = useTranslations('admin.health');
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <RotateCw /> {t('refresh')}
    </Button>
  );
}

export function QueuesPanel() {
  const t = useTranslations('admin.health.queues');
  const waitText = useWaitText();
  const res = useApi<{ queues: QueueHealth[] }>('/admin/queues', undefined, {
    refreshInterval: REFRESH_MS,
  });
  const columns: DataTableColumn<QueueHealth>[] = [
    {
      id: 'queue',
      header: t('queue'),
      rowHeader: true,
      className: 'font-mono text-xs',
      cell: (q) => q.name,
      sortValue: (q) => q.name,
    },
    {
      id: 'waiting',
      header: t('waiting'),
      align: 'end',
      className: MONO,
      sortValue: (q) => q.waiting,
      cell: (q) => <Num value={q.waiting} />,
    },
    {
      id: 'active',
      header: t('active'),
      align: 'end',
      className: MONO,
      sortValue: (q) => q.active,
      cell: (q) => <Num value={q.active} />,
    },
    {
      id: 'failed',
      header: t('failed'),
      align: 'end',
      className: MONO,
      sortValue: (q) => q.failed,
      cell: (q) => <Num value={q.failed} warn />,
    },
    {
      id: 'delayed',
      header: t('delayed'),
      align: 'end',
      className: MONO,
      sortValue: (q) => q.delayed,
      cell: (q) => <Num value={q.delayed} />,
    },
    {
      id: 'oldestWaiting',
      header: t('oldestWaiting'),
      align: 'end',
      className: MONO,
      sortValue: (q) => q.oldestWaitingSec,
      cell: (q) => (
        <span
          className={cn(
            (q.oldestWaitingSec ?? 0) > SLOW_WAIT_SEC && 'font-medium text-warning-foreground',
          )}
        >
          {waitText(q.oldestWaitingSec)}
        </span>
      ),
    },
  ];
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={<Refresh onClick={() => void res.mutate()} />}
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-40" />
      ) : (
        <DataTable
          dense
          caption={t('tableAria')}
          columns={columns}
          rows={res.data.queues}
          getRowId={(q) => q.name}
          className="tabular"
        />
      )}
    </Section>
  );
}

const BREAKER_TONE: Record<ProviderHealth['breaker'], StatusTone> = {
  open: 'bad',
  half_open: 'warn',
  closed: 'good',
};

/** Sorting by breaker puts open circuits first. */
const BREAKER_ORDER: Record<ProviderHealth['breaker'], number> = {
  open: 0,
  half_open: 1,
  closed: 2,
};

function BreakerTag({ state }: { state: ProviderHealth['breaker'] }) {
  const t = useTranslations('admin.health.providers.breakerState');
  return (
    <StatusPill tone={BREAKER_TONE[state]} size="sm">
      {t(state)}
    </StatusPill>
  );
}

export function ProvidersPanel() {
  const t = useTranslations('admin.health.providers');
  const f = useFormat();
  const res = useApi<{ providers: ProviderHealth[] }>('/admin/providers', undefined, {
    refreshInterval: REFRESH_MS,
  });
  const columns: DataTableColumn<ProviderHealth>[] = [
    {
      id: 'provider',
      header: t('provider'),
      rowHeader: true,
      sortValue: (p) => p.id,
      cell: (p) => (
        <>
          {p.id}
          {!p.configured && (
            <span className="ms-1.5 text-xs font-normal text-muted-foreground">
              {t('notConfigured')}
            </span>
          )}
        </>
      ),
    },
    {
      id: 'breaker',
      header: t('breaker'),
      className: 'whitespace-normal',
      sortValue: (p) => BREAKER_ORDER[p.breaker],
      cell: (p) => (
        <>
          <BreakerTag state={p.breaker} />
          {p.accountHold && <AccountHoldNote hold={p.accountHold} />}
        </>
      ),
    },
    {
      id: 'errorRate',
      header: t('errorRate'),
      align: 'end',
      className: MONO,
      sortValue: (p) => p.errorRate1h,
      cell: (p) => (
        <span className={cn((p.errorRate1h ?? 0) >= 0.2 && 'font-medium text-destructive')}>
          {p.errorRate1h === null ? NONE : f.percent(p.errorRate1h, 1)}
        </span>
      ),
    },
    {
      id: 'jobs',
      header: t('jobs'),
      align: 'end',
      className: `${MONO} text-muted-foreground`,
      cell: (p) =>
        p.jobs1h.running > 0
          ? t('jobCountsRunning', {
              succeeded: f.number(p.jobs1h.succeeded),
              failed: f.number(p.jobs1h.failed),
              running: f.number(p.jobs1h.running),
            })
          : t('jobCounts', {
              succeeded: f.number(p.jobs1h.succeeded),
              failed: f.number(p.jobs1h.failed),
            }),
    },
    {
      id: 'spendToday',
      header: t('spendToday'),
      align: 'end',
      className: MONO,
      sortValue: (p) => p.spendTodayPence,
      cell: (p) => f.pence(p.spendTodayPence),
    },
  ];
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={<Refresh onClick={() => void res.mutate()} />}
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label={t('loadingAria')} className="h-40" />
      ) : res.data.providers.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <DataTable
          dense
          caption={t('tableAria')}
          columns={columns}
          rows={res.data.providers}
          getRowId={(p) => p.id}
          className="tabular"
        />
      )}
    </Section>
  );
}
