'use client';

import { RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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

const QUEUE_COLUMNS = ['waiting', 'active', 'failed', 'delayed', 'oldestWaiting'] as const;

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
    <td
      className={cn(
        'tabular py-1.5 text-end',
        warn && value > 0 && 'font-medium text-warning-foreground',
      )}
    >
      {f.number(value)}
    </td>
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
        <table aria-label={t('tableAria')} className="w-full text-sm">
          <thead>
            <tr className="text-start text-xs text-muted-foreground">
              <th scope="col" className="py-1 text-start font-normal">
                {t('queue')}
              </th>
              {QUEUE_COLUMNS.map((h) => (
                <th key={h} scope="col" className="py-1 text-end font-normal">
                  {t(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.data.queues.map((q) => (
              <tr key={q.name} className="border-t border-border/60">
                <th scope="row" className="py-1.5 text-start font-medium">
                  {q.name}
                </th>
                <Num value={q.waiting} />
                <Num value={q.active} />
                <Num value={q.failed} warn />
                <Num value={q.delayed} />
                <td
                  className={cn(
                    'tabular py-1.5 text-end',
                    (q.oldestWaitingSec ?? 0) > SLOW_WAIT_SEC &&
                      'font-medium text-warning-foreground',
                  )}
                >
                  {waitText(q.oldestWaitingSec)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function BreakerTag({ state }: { state: ProviderHealth['breaker'] }) {
  const t = useTranslations('admin.health.providers.breakerState');
  return (
    <span
      className={cn(
        'rounded px-1.5 py-px text-xs',
        state === 'open'
          ? 'bg-destructive/10 text-destructive'
          : state === 'half_open'
            ? 'bg-warning-soft text-warning-foreground'
            : 'bg-success-soft text-success-foreground',
      )}
    >
      {t(state)}
    </span>
  );
}

export function ProvidersPanel() {
  const t = useTranslations('admin.health.providers');
  const f = useFormat();
  const res = useApi<{ providers: ProviderHealth[] }>('/admin/providers', undefined, {
    refreshInterval: REFRESH_MS,
  });
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
        <table aria-label={t('tableAria')} className="w-full text-sm">
          <thead>
            <tr className="text-start text-xs text-muted-foreground">
              <th scope="col" className="py-1 text-start font-normal">
                {t('provider')}
              </th>
              <th scope="col" className="py-1 text-start font-normal">
                {t('breaker')}
              </th>
              <th scope="col" className="py-1 text-end font-normal">
                {t('errorRate')}
              </th>
              <th scope="col" className="py-1 text-end font-normal">
                {t('jobs')}
              </th>
              <th scope="col" className="py-1 text-end font-normal">
                {t('spendToday')}
              </th>
            </tr>
          </thead>
          <tbody>
            {res.data.providers.map((p) => (
              <tr key={p.id} className="border-t border-border/60">
                <th scope="row" className="py-1.5 text-start font-medium">
                  {p.id}
                  {!p.configured && (
                    <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                      {t('notConfigured')}
                    </span>
                  )}
                </th>
                <td className="py-1.5">
                  <BreakerTag state={p.breaker} />
                  {p.accountHold && <AccountHoldNote hold={p.accountHold} />}
                </td>
                <td
                  className={cn(
                    'tabular py-1.5 text-end',
                    (p.errorRate1h ?? 0) >= 0.2 && 'font-medium text-destructive',
                  )}
                >
                  {p.errorRate1h === null ? NONE : f.percent(p.errorRate1h, 1)}
                </td>
                <td className="tabular py-1.5 text-end text-muted-foreground">
                  {p.jobs1h.running > 0
                    ? t('jobCountsRunning', {
                        succeeded: f.number(p.jobs1h.succeeded),
                        failed: f.number(p.jobs1h.failed),
                        running: f.number(p.jobs1h.running),
                      })
                    : t('jobCounts', {
                        succeeded: f.number(p.jobs1h.succeeded),
                        failed: f.number(p.jobs1h.failed),
                      })}
                </td>
                <td className="tabular py-1.5 text-end">{f.pence(p.spendTodayPence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
