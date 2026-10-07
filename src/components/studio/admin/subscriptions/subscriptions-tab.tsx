'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section, Stat } from '../../primitives';
import type { AdminSubscription } from '../organisations/organisations-tab';
import { StatusBadge } from '../organisations/status-badge';

// Phase 18 §3 admin → Subscriptions (read-only): every Stripe subscription as Track C stores it,
// counts per status, a status filter and, for past-due ones, the end of the grace period.
// Changes happen in Stripe or through an entitlement override, never here.

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'incomplete',
  'paused',
] as const;

export interface AdminSubscriptionsResponse {
  ok: true;
  total: number;
  byStatus: Record<string, number>;
  data: Array<AdminSubscription & { organisationName: string | null; graceUntil: string | null }>;
}

export function SubscriptionsTab() {
  const t = useTranslations('adminOrgs.subscriptions');
  const ts = useTranslations('adminOrgs.status');
  const f = useFormat();
  const [status, setStatus] = useState<string>('');
  const { data, error, mutate } = useApi<AdminSubscriptionsResponse>('/admin/subscriptions', {
    status: status || undefined,
  });
  const statusKey = {
    trialing: 'trialing',
    active: 'active',
    past_due: 'pastDue',
    unpaid: 'unpaid',
    canceled: 'canceled',
    incomplete: 'incomplete',
    paused: 'paused',
  } as const;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">{t('readOnlyNote')}</p>
      {data && (
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {(['active', 'trialing', 'past_due', 'unpaid'] as const).map((s) => (
            <Stat key={s} label={ts(statusKey[s])} value={f.number(data.byStatus[s] ?? 0)} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="sub-status">{t('filter')}</Label>
          <NativeSelect id="sub-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('all')}</option>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ts(statusKey[s])}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : data.data.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Section title={t('results', { count: data.total })}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('organisation')}</TableHead>
                  <TableHead>{t('plan')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('renews')}</TableHead>
                  <TableHead>{t('grace')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <span className="font-medium">{s.organisationName ?? s.organisationId}</span>
                      <span className="block font-mono text-xs text-muted-foreground" dir="ltr">
                        {s.id}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      {s.lookupKey ?? '–'}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge value={s.status} />
                        {s.cancelAtPeriodEnd && (
                          <span className="text-xs text-muted-foreground">{t('cancelling')}</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.currentPeriodEnd ? f.date(s.currentPeriodEnd) : '–'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.status === 'past_due' && s.graceUntil ? f.date(s.graceUntil) : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
    </div>
  );
}
