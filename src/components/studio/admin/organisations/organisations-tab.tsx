'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Search } from 'lucide-react';
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
import { PlanOverrideSection } from '../billing/entitlements-panel';
import { CostCapsSection, OrganisationPanel, PolicySection } from '../organisation-panel';
import { StatusBadge } from './status-badge';

// Phase 18 §3 admin → Organisations: search every organisation (name, slug or id) with plan,
// access, trial, subscription status, members and AI cost this month, a page at a time; open one
// for its members and subscriptions, then (20.27) its plan: effective entitlements, the trial,
// the override form (tier, access, expiry, End the trial now, reason) and removing it, and the
// review policy and cost-cap forms beneath.

export type TrialState = 'running' | 'overridden' | 'ended';

export interface AdminOrgTrial {
  state: TrialState;
  endsAt: string | null;
}

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
  source: string | null;
  trial: AdminOrgTrial | null;
  subscriptionStatus: string | null;
  costThisMonthPence: number;
}

export interface AdminOrgsResponse {
  ok: true;
  total: number;
  offset: number;
  pageSize: number;
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
    trial: AdminOrgTrial | null;
    graceUntil: string | null;
    trialStartedAt: string | null;
    everPaidAt: string | null;
    reason: string | null;
    updatedAt: string;
  } | null;
  subscriptions: AdminSubscription[];
  costThisMonthPence: number;
}

/** The trial cell of the list: running until a date, paused by an override, or ended. */
export function TrialLabel({ trial }: { trial: AdminOrgTrial | null }) {
  const t = useTranslations('adminOrgs.list.trialState');
  const f = useFormat();
  if (!trial) return <span className="text-muted-foreground">–</span>;
  if (trial.state === 'running')
    return (
      <span className="font-medium text-amber-700 dark:text-amber-400">
        {trial.endsAt
          ? t('running', { date: f.date(trial.endsAt, { dateStyle: 'medium' }) })
          : t('runningNoDate')}
      </span>
    );
  return <span className="text-muted-foreground">{t(trial.state)}</span>;
}

function OrganisationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('adminOrgs.detail');
  const f = useFormat();
  const { data, error, mutate } = useApi<AdminOrgDetail>(
    `/admin/organisations/${encodeURIComponent(id)}`,
  );
  return (
    <div className="grid min-w-0 gap-6">
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
                hint={
                  data.entitlement?.trial ? (
                    <TrialLabel trial={data.entitlement.trial} />
                  ) : undefined
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
          {/* 20.27: the plan override beside the cost caps (same card pattern), policy below. */}
          <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
            <PlanOverrideSection orgId={data.organisation.id} />
            <CostCapsSection orgId={data.organisation.id} />
          </div>
          <PolicySection orgId={data.organisation.id} />
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
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
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('name')}</TableHead>
            <TableHead>{t('plan')}</TableHead>
            <TableHead>{t('status')}</TableHead>
            <TableHead>{t('trial')}</TableHead>
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
                  {o.id}
                </span>
              </TableCell>
              <TableCell>{o.tier ?? '–'}</TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  {o.deletedAt && <StatusBadge value="deleted" />}
                  {o.subscriptionStatus && <StatusBadge value={o.subscriptionStatus} />}
                  {o.access && <StatusBadge value={o.access} />}
                </span>
              </TableCell>
              <TableCell>
                <TrialLabel trial={o.trial} />
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
                  onClick={() => onOpen(o.id)}
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
    <div className="grid min-w-0 gap-6">
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
