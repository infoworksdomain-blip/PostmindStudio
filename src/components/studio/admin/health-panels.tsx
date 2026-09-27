'use client';

import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { formatPence } from '@/lib/client/format';
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
  healthy: boolean;
}

const REFRESH_MS = 30_000;
/** A job waiting longer than this is worth a look (spec 11.3 queue latency targets are minutes). */
const SLOW_WAIT_SEC = 300;

function waitText(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function Num({ value, warn }: { value: number; warn?: boolean }) {
  return (
    <td
      className={cn(
        'tabular py-1.5 text-right',
        warn && value > 0 && 'font-medium text-amber-700 dark:text-amber-400',
      )}
    >
      {value.toLocaleString('en-GB')}
    </td>
  );
}

function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <RotateCw /> Refresh
    </Button>
  );
}

export function QueuesPanel() {
  const res = useApi<{ queues: QueueHealth[] }>('/admin/queues', undefined, {
    refreshInterval: REFRESH_MS,
  });
  return (
    <Section
      title="Queue health"
      description="BullMQ depth per queue (spec 16.4). Failed jobs stay until an operator re-drives them."
      actions={<Refresh onClick={() => void res.mutate()} />}
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading queues" className="h-40" />
      ) : (
        <table aria-label="Queue health" className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                Queue
              </th>
              {['Waiting', 'Active', 'Failed', 'Delayed', 'Oldest waiting'].map((h) => (
                <th key={h} scope="col" className="py-1 text-right font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.data.queues.map((q) => (
              <tr key={q.name} className="border-t border-border/60">
                <th scope="row" className="py-1.5 text-left font-medium">
                  {q.name}
                </th>
                <Num value={q.waiting} />
                <Num value={q.active} />
                <Num value={q.failed} warn />
                <Num value={q.delayed} />
                <td
                  className={cn(
                    'tabular py-1.5 text-right',
                    (q.oldestWaitingSec ?? 0) > SLOW_WAIT_SEC &&
                      'font-medium text-amber-700 dark:text-amber-400',
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

const BREAKER_LABEL: Record<ProviderHealth['breaker'], string> = {
  closed: 'Closed',
  half_open: 'Half-open (trial)',
  open: 'Open',
};

function BreakerTag({ state }: { state: ProviderHealth['breaker'] }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-px text-xs',
        state === 'open'
          ? 'bg-destructive/10 text-destructive'
          : state === 'half_open'
            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
      )}
    >
      {BREAKER_LABEL[state]}
    </span>
  );
}

export function ProvidersPanel() {
  const res = useApi<{ providers: ProviderHealth[] }>('/admin/providers', undefined, {
    refreshInterval: REFRESH_MS,
  });
  return (
    <Section
      title="Provider health"
      description="Circuit breakers are shared by every worker (Redis). Error rate counts provider-side failures of jobs started in the last hour; spend is today (UTC)."
      actions={<Refresh onClick={() => void res.mutate()} />}
    >
      {res.error ? (
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      ) : !res.data ? (
        <Skeleton aria-label="Loading providers" className="h-40" />
      ) : res.data.providers.length === 0 ? (
        <EmptyState title="No providers yet" description="No provider is configured or has run." />
      ) : (
        <table aria-label="Provider health" className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                Provider
              </th>
              <th scope="col" className="py-1 font-normal">
                Breaker
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Error rate (1 h)
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Jobs (1 h)
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                Spend today
              </th>
            </tr>
          </thead>
          <tbody>
            {res.data.providers.map((p) => (
              <tr key={p.id} className="border-t border-border/60">
                <th scope="row" className="py-1.5 text-left font-medium">
                  {p.id}
                  {!p.configured && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      not configured
                    </span>
                  )}
                </th>
                <td className="py-1.5">
                  <BreakerTag state={p.breaker} />
                </td>
                <td
                  className={cn(
                    'tabular py-1.5 text-right',
                    (p.errorRate1h ?? 0) >= 0.2 && 'font-medium text-destructive',
                  )}
                >
                  {p.errorRate1h === null ? '—' : `${Math.round(p.errorRate1h * 1000) / 10}%`}
                </td>
                <td className="tabular py-1.5 text-right text-muted-foreground">
                  {p.jobs1h.succeeded} ok · {p.jobs1h.failed} failed
                  {p.jobs1h.running > 0 && ` · ${p.jobs1h.running} running`}
                </td>
                <td className="tabular py-1.5 text-right">{formatPence(p.spendTodayPence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
