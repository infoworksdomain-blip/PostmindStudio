'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section } from '../../primitives';
import { selectClass } from '../../library/library-filters';
import {
  isSubscriptionStatus,
  PLAN_TIERS,
  type AdminSubscriptionsResponse,
  type SubscriptionStatus,
} from '../../billing/types';

// Phase 18 §P.4 — staff subscriptions list (GET /admin/billing/subscriptions?status=&limit=):
// total MRR (active + past due, annual ÷ 12, ex-VAT), counts by tier and by status, a status
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
  const tInterval = useTranslations('pricing.interval');
  const f = useFormat();
  const [status, setStatus] = useState<SubscriptionStatus | ''>('');
  const res = useApi<AdminSubscriptionsResponse>('/admin/billing/subscriptions', {
    status,
    limit: 100,
  });
  const statusLabel = (s: string) => (isSubscriptionStatus(s) ? tStatus(s) : s);
  const intervalLabel = (i: string | null) =>
    i === 'month' || i === 'year' ? tInterval(i) : (i ?? '—');

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
          <select
            id="subs-status"
            className={selectClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as SubscriptionStatus | '')}
          >
            <option value="">{t('allStatuses')}</option>
            {FILTERS.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </select>
        </div>
        {subscriptions.length === 0 ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem]">
              <caption className="sr-only">{t('caption')}</caption>
              <thead>
                <tr className="text-muted-foreground">
                  {(
                    ['organisation', 'tier', 'interval', 'mrr', 'periodEnd', 'status'] as const
                  ).map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className={
                        col === 'mrr'
                          ? 'py-2 pe-3 text-end font-medium'
                          : 'py-2 pe-3 text-start font-medium'
                      }
                    >
                      {t(`columns.${col}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-2 pe-3">
                      <span className="block font-medium">
                        {s.organisationName ?? t('unknownOrg')}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {s.organisationId}
                      </span>
                    </td>
                    <td className="py-2 pe-3">{s.tier ? tTier(s.tier) : t('unknownTier')}</td>
                    <td className="py-2 pe-3">{intervalLabel(s.interval)}</td>
                    <td className="py-2 pe-3 text-end tabular-nums">{f.pence(s.mrrPence)}</td>
                    <td className="py-2 pe-3">
                      {f.date(s.currentPeriodEnd, { dateStyle: 'medium' })}
                    </td>
                    <td className="py-2 pe-3">
                      {statusLabel(s.status)}
                      {s.cancelAtPeriodEnd && (
                        <span className="ms-2 rounded bg-warning/20 px-1.5 text-xs">
                          {t('cancelling')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
