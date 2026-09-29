'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { OrganisationPanel } from '../organisation-panel';
import { StatusBadge } from './status-badge';

// Phase 18 §3 admin → Organisations: search every organisation (name, slug or id) with plan,
// billing access, subscription status, members and cost this month; open one for its members,
// entitlement and subscriptions, with the existing policy and cost-cap forms beneath.

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  createdAt: string;
  deletedAt: string | null;
  members: number;
  tier: string | null;
  access: string | null;
  subscriptionStatus: string | null;
  costThisMonthPence: number;
}

export interface AdminOrgsResponse {
  ok: true;
  total: number;
  data: AdminOrgRow[];
}

export interface AdminSubscription {
  id: string;
  organisationId: string;
  status: string;
  lookupKey: string | null;
  interval: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
  updatedAt: string;
}

export interface AdminOrgDetail {
  ok: true;
  organisation: {
    id: string;
    name: string;
    slug: string;
    country: string | null;
    defaultLocale: string | null;
    createdAt: string;
    deletedAt: string | null;
  };
  members: Array<{
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    twoFactorEnabled: boolean;
    joinedAt: string;
  }>;
  pendingInvitations: number;
  businesses: number;
  entitlement: {
    tier: string;
    access: string;
    source: string;
    graceUntil: string | null;
    trialStartedAt: string | null;
    everPaidAt: string | null;
    reason: string | null;
    updatedAt: string;
  } | null;
  subscriptions: AdminSubscription[];
  costThisMonthPence: number;
}

function OrganisationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('adminOrgs.detail');
  const f = useFormat();
  const { data, error, mutate } = useApi<AdminOrgDetail>(
    `/admin/organisations/${encodeURIComponent(id)}`,
  );
  return (
    <div className="grid gap-6">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="rtl:-scale-x-100" /> {t('back')}
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !data ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t('loading')} />
      ) : (
        <>
          <Section
            title={data.organisation.name}
            description={t('meta', {
              id: data.organisation.id,
              created: f.date(data.organisation.createdAt),
            })}
            actions={data.organisation.deletedAt ? <StatusBadge value="deleted" /> : undefined}
          >
            <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
              <Stat
                label={t('plan')}
                value={data.entitlement?.tier ?? t('none')}
                hint={
                  data.entitlement ? t(`sources.${sourceKey(data.entitlement.source)}`) : undefined
                }
              />
              <Stat
                label={t('access')}
                value={
                  data.entitlement ? <StatusBadge value={data.entitlement.access} /> : t('none')
                }
              />
              <Stat
                label={t('members')}
                value={f.number(data.members.length)}
                hint={t('pending', { count: data.pendingInvitations })}
              />
              <Stat
                label={t('cost')}
                value={f.pence(data.costThisMonthPence)}
                hint={t('businesses', { count: data.businesses })}
              />
            </div>
            {data.entitlement?.graceUntil && (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('graceUntil', { date: f.date(data.entitlement.graceUntil) })}
              </p>
            )}
          </Section>
          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={t('membersTitle')}>
              <ul className="divide-y divide-border text-sm">
                {data.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.name}</span>
                      <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                        {m.email}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{m.role}</span>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title={t('subscriptionsTitle')} description={t('subscriptionsHint')}>
              {data.subscriptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noSubscription')}</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {data.subscriptions.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="font-mono text-xs" dir="ltr">
                        {s.lookupKey ?? s.id}
                      </span>
                      <span className="flex items-center gap-2">
                        {s.cancelAtPeriodEnd && (
                          <span className="text-xs text-muted-foreground">{t('cancelling')}</span>
                        )}
                        <StatusBadge value={s.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
          <OrganisationPanel initialOrgId={data.organisation.id} />
        </>
      )}
    </div>
  );
}

const SOURCES = ['stripe', 'trial', 'admin', 'core', 'none'] as const;
function sourceKey(source: string): (typeof SOURCES)[number] {
  return (SOURCES as readonly string[]).includes(source)
    ? (source as (typeof SOURCES)[number])
    : 'none';
}

export function OrganisationsTab() {
  const t = useTranslations('adminOrgs.list');
  const f = useFormat();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, mutate } = useApi<AdminOrgsResponse>('/admin/organisations', { q });

  if (open) return <OrganisationDetail id={open} onBack={() => setOpen(null)} />;

  return (
    <div className="grid gap-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setQ(input.trim());
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="admin-org-search">{t('search')}</Label>
          <Input
            id="admin-org-search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-80"
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
        <Section title={t('results', { count: data.total })}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('name')}</TableHead>
                  <TableHead>{t('plan')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead className="text-end">{t('members')}</TableHead>
                  <TableHead className="text-end">{t('cost')}</TableHead>
                  <TableHead>{t('created')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <span className="font-medium">{o.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground" dir="ltr">
                        {o.slug}
                      </span>
                    </TableCell>
                    <TableCell>{o.tier ?? '–'}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">
                        {o.deletedAt && <StatusBadge value="deleted" />}
                        {o.subscriptionStatus && <StatusBadge value={o.subscriptionStatus} />}
                        {o.access && o.access !== 'full' && <StatusBadge value={o.access} />}
                      </span>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{f.number(o.members)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {f.pence(o.costThisMonthPence)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.date(o.createdAt)}</TableCell>
                    <TableCell className="text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOpen(o.id)}
                        aria-label={t('openAria', { name: o.name })}
                      >
                        {t('open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
