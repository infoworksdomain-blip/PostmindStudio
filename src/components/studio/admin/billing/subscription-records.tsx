'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Stat } from '../../primitives';
import type { AdminSubscription } from '../organisations/types';
import { StatusBadge } from '../organisations/status-badge';

// Phase 18 §3 admin → Subscriptions & billing → Stripe records (read-only; was the separate
// "Subscriptions" tab until 25.13): every Stripe subscription as Track C stores it, counts per
// status, a status filter, the Stripe ids and price lookup keys and, for past-due ones, the end of
// the grace period. Changes happen in Stripe or through an entitlement override, never here.

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'paused',
] as const;

const STATUS_KEY = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'pastDue',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  paused: 'paused',
} as const satisfies Record<(typeof SUBSCRIPTION_STATUSES)[number], string>;

type RecordRow = AdminSubscription & { organisationName: string | null; graceUntil: string | null };

export interface AdminSubscriptionsResponse {
  ok: true;
  total: number;
  byStatus: Record<string, number>;
  data: RecordRow[];
}

const NONE = '–';
const time = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

export function SubscriptionRecords() {
  const t = useTranslations('adminOrgs.subscriptions');
  const ts = useTranslations('adminOrgs.status');
  const f = useFormat();
  const [status, setStatus] = useState<string>('');
  const { data, error, mutate } = useApi<AdminSubscriptionsResponse>('/admin/subscriptions', {
    status: status || undefined,
  });

  const columns: DataTableColumn<RecordRow>[] = [
    {
      id: 'organisation',
      header: t('organisation'),
      rowHeader: true,
      sortValue: (s) => s.organisationName ?? s.organisationId,
      cell: (s) => (
        <>
          <span className="block">{s.organisationName ?? s.organisationId}</span>
          <span className="block font-mono text-xs font-normal text-muted-foreground" dir="ltr">
            {s.id}
          </span>
        </>
      ),
    },
    {
      id: 'plan',
      header: t('plan'),
      className: 'font-mono text-xs',
      sortValue: (s) => s.lookupKey,
      cell: (s) => <span dir="ltr">{s.lookupKey ?? NONE}</span>,
    },
    {
      id: 'status',
      header: t('status'),
      sortValue: (s) => s.status,
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge value={s.status} />
          {s.cancelAtPeriodEnd && (
            <span className="text-xs text-muted-foreground">{t('cancelling')}</span>
          )}
        </span>
      ),
    },
    {
      id: 'renews',
      header: t('renews'),
      className: 'font-mono text-xs text-muted-foreground',
      sortValue: (s) => time(s.currentPeriodEnd),
      cell: (s) => (s.currentPeriodEnd ? f.date(s.currentPeriodEnd) : NONE),
    },
    {
      id: 'grace',
      header: t('grace'),
      className: 'font-mono text-xs text-muted-foreground',
      sortValue: (s) => (s.status === 'past_due' ? time(s.graceUntil) : null),
      cell: (s) => (s.status === 'past_due' && s.graceUntil ? f.date(s.graceUntil) : NONE),
    },
  ];

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">{t('readOnlyNote')}</p>
      {data && (
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {(['active', 'trialing', 'past_due', 'unpaid'] as const).map((s) => (
            <Stat key={s} label={ts(STATUS_KEY[s])} value={f.number(data.byStatus[s] ?? 0)} />
          ))}
        </div>
      )}
      <div className="grid max-w-60 gap-1.5">
        <Label htmlFor="sub-status">{t('filter')}</Label>
        <NativeSelect id="sub-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('all')}</option>
          {SUBSCRIPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ts(STATUS_KEY[s])}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : (
        <DataTable
          dense
          caption={t('results', { count: data.total })}
          showCaption
          columns={columns}
          rows={data.data}
          getRowId={(s) => s.id}
          empty={t('empty')}
          maxHeight="70vh"
        />
      )}
    </div>
  );
}
