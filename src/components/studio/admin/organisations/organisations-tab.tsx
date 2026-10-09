'use client';

import { useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { EmptyState, ErrorState, Section } from '../../primitives';
import { OrganisationPanel } from '../organisation-panel';
import { OrganisationDetail, StudioPlanLabel, TrialLabel } from './organisation-detail';
import { StatusBadge } from './status-badge';
import type { AdminOrgRow, AdminOrgsResponse } from './types';

// Phase 18 §3 admin → Organisations: search every organisation (name, slug or id) with plan,
// access, trial, subscription status, members and AI cost this month, a page at a time (the
// server pages, so the table does not sort); open one for its members, subscriptions, plan,
// policy and cost caps (organisation-detail.tsx).

function Pager({
  data,
  onOffset,
}: {
  data: AdminOrgsResponse;
  onOffset: (offset: number) => void;
}) {
  const t = useTranslations('adminOrgs.list');
  const f = useFormat();
  const pageSize = data.pageSize || data.data.length || 1;
  if (data.total <= pageSize) return null;
  const from = data.offset + 1;
  const to = data.offset + data.data.length;
  return (
    <nav aria-label={t('pagesAria')} className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">
        {t('pageInfo', { from: f.number(from), to: f.number(to), total: f.number(data.total) })}
      </span>
      <span className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={data.offset === 0}
          onClick={() => onOffset(Math.max(0, data.offset - pageSize))}
        >
          <ChevronLeft className="rtl:-scale-x-100" /> {t('previous')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={to >= data.total}
          onClick={() => onOffset(data.offset + pageSize)}
        >
          {t('next')} <ChevronRight className="rtl:-scale-x-100" />
        </Button>
      </span>
    </nav>
  );
}

function OrganisationsTable({
  data,
  onOpen,
}: {
  data: AdminOrgsResponse;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('adminOrgs.list');
  const f = useFormat();
  const columns: DataTableColumn<AdminOrgRow>[] = [
    {
      id: 'name',
      header: t('name'),
      rowHeader: true,
      cell: (o) => (
        <>
          <span className="block">{o.name}</span>
          <span className="block font-mono text-xs font-normal text-muted-foreground" dir="ltr">
            {o.id}
          </span>
        </>
      ),
    },
    {
      id: 'plan',
      header: t('plan'),
      cell: (o) => (
        <>
          {o.tier ?? '–'}
          <StudioPlanLabel plan={o.studioPlan} />
        </>
      ),
    },
    {
      id: 'status',
      header: t('status'),
      cell: (o) => (
        <span className="flex flex-wrap gap-1">
          {o.deletedAt && <StatusBadge value="deleted" />}
          {o.subscriptionStatus && <StatusBadge value={o.subscriptionStatus} />}
          {o.access && <StatusBadge value={o.access} />}
        </span>
      ),
    },
    { id: 'trial', header: t('trial'), cell: (o) => <TrialLabel trial={o.trial} /> },
    {
      id: 'members',
      header: t('members'),
      align: 'end',
      className: 'font-mono text-xs',
      cell: (o) => f.number(o.members),
    },
    {
      id: 'cost',
      header: t('cost'),
      align: 'end',
      className: 'font-mono text-xs',
      cell: (o) => f.pence(o.costThisMonthPence),
    },
    {
      id: 'created',
      header: t('created'),
      className: 'font-mono text-xs text-muted-foreground',
      cell: (o) => f.date(o.createdAt),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('actions')}</span>,
      align: 'end',
      cell: (o) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpen(o.id)}
          aria-label={t('openAria', { name: o.name })}
        >
          {t('open')}
        </Button>
      ),
    },
  ];
  return (
    <DataTable
      dense
      caption={t('results', { count: data.total })}
      columns={columns}
      rows={data.data}
      getRowId={(o) => o.id}
    />
  );
}

export function OrganisationsTab() {
  const t = useTranslations('adminOrgs.list');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, mutate } = useApi<AdminOrgsResponse>('/admin/organisations', {
    q,
    offset,
  });

  if (open) return <OrganisationDetail id={open} onBack={() => setOpen(null)} />;

  return (
    <div className="grid min-w-0 gap-10">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setQ(input.trim());
          setOffset(0);
        }}
      >
        <div className="grid w-full gap-1.5 sm:w-auto">
          <Label htmlFor="admin-org-search">{t('search')}</Label>
          <Input
            id="admin-org-search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full sm:w-80"
            maxLength={120}
          />
        </div>
        <Button type="submit" variant="outline">
          <Search /> {t('searchAction')}
        </Button>
      </form>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : data.data.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Section title={t('results', { count: data.total })} description={t('planHint')}>
          <div className="grid gap-4">
            <OrganisationsTable data={data} onOpen={setOpen} />
            <Pager data={data} onOffset={setOffset} />
          </div>
        </Section>
      )}
      {/* Core mode keeps organisations in PostMind Core: open one by id, as before Phase 18. */}
      <Section title={t('byIdTitle')} description={t('byIdHint')}>
        <OrganisationPanel />
      </Section>
    </div>
  );
}
