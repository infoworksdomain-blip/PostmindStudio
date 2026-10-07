'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../../primitives';
import {
  isSubscriptionStatus,
  PLAN_TIERS,
  type AdminSubscriptionsResponse,
  type AdminSubscriptionRow,
  type SubscriptionStatus,
} from '../../billing/types';
import { isChannelInterval } from './entitlements-summary';

// Phase 18 §P.4 — staff subscriptions list (GET /admin/billing/subscriptions?status=&limit=):
// total MRR (active + past due, annual ÷ 12, weekly × 52 ÷ 12, ex-VAT), counts by tier and by status, a status
// filter, and each subscription with its organisation, tier, interval, MRR, period end and
// whether it cancels at period end.

/** Filterable statuses (the API's adminSubscriptionsQuery enum). */
const FILTERS = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'paused',
] as const satisfies readonly SubscriptionStatus[];

export function SubscriptionsPanel() {
  const t = useTranslations('billing.admin.subscriptions');
  const tStatus = useTranslations('billing.subscriptionStatus');
  const tTier = useTranslations('shell.usage.tiers');
  const tInterval = useTranslations('billing.admin.entitlements.intervalValues');
  const f = useFormat();
  const [status, setStatus] = useState<SubscriptionStatus | ''>('');
  const res = useApi<AdminSubscriptionsResponse>('/admin/billing/subscriptions', {
    status,
    limit: 100,
  });
  const statusLabel = (s: string) => (isSubscriptionStatus(s) ? tStatus(s) : s);
  const intervalLabel = (i: string | null) => (isChannelInterval(i) ? tInterval(i) : (i ?? '—'));

  const columns: DataTableColumn<AdminSubscriptionRow>[] = [
    {
      id: 'organisation',
      header: t('columns.organisation'),
      cell: (s) => (
        <>
          <span className="block font-medium">{s.organisationName ?? t('unknownOrg')}</span>
          <span className="block text-xs text-muted-foreground">{s.organisationId}</span>
        </>
      ),
    },
    {
      id: 'tier',
      header: t('columns.tier'),
      cell: (s) => (s.tier ? tTier(s.tier) : t('unknownTier')),
    },
    { id: 'interval', header: t('columns.interval'), cell: (s) => intervalLabel(s.interval) },
    {
      id: 'mrr',
      header: t('columns.mrr'),
      align: 'end',
      className: 'tabular-nums',
      cell: (s) => f.pence(s.mrrPence),
    },
    {
      id: 'periodEnd',
      header: t('columns.periodEnd'),
      cell: (s) => f.date(s.currentPeriodEnd, { dateStyle: 'medium' }),
    },
    {
      id: 'status',
      header: t('columns.status'),
      cell: (s) => (
        <>
          {statusLabel(s.status)}
          {s.cancelAtPeriodEnd && (
            <StatusPill tone="warn" size="sm" className="ms-2">
              {t('cancelling')}
            </StatusPill>
          )}
        </>
      ),
    },
  ];

  if (res.error) return <ErrorState error={res.error} onRetry={() => void res.mutate()} />;
  if (!res.data) return <Skeleton aria-label={t('loading')} className="h-64 rounded-xl" />;
  const { summary, subscriptions } = res.data;
  return (
    <Section title={t('title')} description={t('description')}>
      <div className="grid gap-6 text-sm">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="grid gap-1">
            <p className="text-muted-foreground">{t('mrr')}</p>
            <p className="font-display text-4xl leading-none tabular-nums">
              {f.pence(summary.mrrPence)}
            </p>
            <p className="text-xs text-muted-foreground">{t('mrrHelp')}</p>
            <p className="text-xs text-muted-foreground">{t('total', { count: summary.total })}</p>
          </div>
          <div className="grid content-start gap-1">
            <p className="text-muted-foreground">{t('byTier')}</p>
            <ul aria-label={t('byTierAria')} className="grid gap-0.5">
              {PLAN_TIERS.map((tier) => {
                const row = summary.byTier[tier] ?? { count: 0, mrrPence: 0 };
                return (
                  <li key={tier} className="flex justify-between gap-3">
                    <span>{tTier(tier)}</span>
                    <span className="tabular-nums">
                      {t('tierLine', { count: row.count, mrr: f.pence(row.mrrPence) })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="grid content-start gap-1">
            <p className="text-muted-foreground">{t('byStatus')}</p>
            <ul aria-label={t('byStatusAria')} className="grid gap-0.5">
              {Object.entries(summary.byStatus).map(([s, count]) => (
                <li key={s} className="flex justify-between gap-3">
                  <span>{statusLabel(s)}</span>
                  <span className="tabular-nums">{f.number(count)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="grid max-w-60 gap-1.5">
          <Label htmlFor="subs-status">{t('filter')}</Label>
          <NativeSelect
            id="subs-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as SubscriptionStatus | '')}
          >
            <option value="">{t('allStatuses')}</option>
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {subscriptions.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <DataTable
            caption={t('caption')}
            columns={columns}
            rows={subscriptions}
            getRowId={(s) => s.id}
          />
        )}
      </div>
    </Section>
  );
}
