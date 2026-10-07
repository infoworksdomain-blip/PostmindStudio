'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { ErrorState, Section, Stat } from '../../primitives';
import { PlanOverrideSection } from '../billing/entitlements-panel';
import { CostCapsSection, PolicySection } from '../organisation-panel';
import { StatusBadge } from './status-badge';
import type { AdminOrgChannelPlan, AdminOrgDetail, AdminOrgTrial } from './types';

// Phase 18 §3 admin → Organisations → one organisation (split out of organisations-tab.tsx in
// 25.13): its members and subscriptions, then (20.27) its plan: effective entitlements, the
// trial, the override form and removing it, and the review policy and cost-cap forms beneath.

/** The trial cell of the list: running until a date, paused by an override, or ended. */
export function TrialLabel({ trial }: { trial: AdminOrgTrial | null }) {
  const t = useTranslations('adminOrgs.list.trialState');
  const f = useFormat();
  if (!trial) return <span className="text-muted-foreground">–</span>;
  if (trial.state === 'running')
    return (
      <span className="font-medium text-warning-foreground">
        {trial.endsAt
          ? t('running', { date: f.date(trial.endsAt, { dateStyle: 'medium' }) })
          : t('runningNoDate')}
      </span>
    );
  return <span className="text-muted-foreground">{t(trial.state)}</span>;
}

/** 21.5: "3 channels · monthly" for an organisation on a channel plan, nothing otherwise. */
export function ChannelPlanLabel({ plan }: { plan: AdminOrgChannelPlan | null | undefined }) {
  const t = useTranslations('adminOrgs.list');
  if (!plan) return null;
  return (
    <span className="block text-xs text-muted-foreground" data-testid="org-channel-plan">
      {t('channelPlan', { count: plan.channels, interval: plan.interval })}
    </span>
  );
}

export function OrganisationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations('adminOrgs.detail');
  const f = useFormat();
  const { data, error, mutate } = useApi<AdminOrgDetail>(
    `/admin/organisations/${encodeURIComponent(id)}`,
  );
  return (
    <div className="grid min-w-0 gap-10">
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
            variant="panel"
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
                  data.entitlement ? (
                    <>
                      {t(`sources.${sourceKey(data.entitlement.source)}`)}
                      <ChannelPlanLabel plan={data.entitlement.channelPlan} />
                    </>
                  ) : undefined
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
          <div className="grid min-w-0 items-start gap-x-8 gap-y-10 lg:grid-cols-2">
            <PlanOverrideSection orgId={data.organisation.id} />
            <CostCapsSection orgId={data.organisation.id} />
          </div>
          <PolicySection orgId={data.organisation.id} />
          <div className="grid min-w-0 gap-x-8 gap-y-10 lg:grid-cols-2">
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
