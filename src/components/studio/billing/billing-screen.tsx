'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreditCard, Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { useFormat, type Tone } from '@/lib/client/format';
import { EmptyState, ErrorState, PageHeader, Section, StateBadge } from '../primitives';
import { SettingsNav } from '../settings/settings-nav';
import { InvoicesSection, TopUpsSection, UsageSection } from './billing-sections';
import { IntervalToggle, PlanCards } from './plan-cards';
import {
  isLiveSubscription,
  type BillingInterval,
  type BillingResponse,
  type PlansResponse,
  type SelfServeTier,
} from './types';
import { useBillingActions, type CheckoutIntent } from './use-billing-actions';

// Phase 18 §3 /settings/billing — the organisation's plan and status (trial, active, past due
// with the grace countdown, read-only, cancelling at period end, no plan), renewal date, usage
// meters, top-up credits and packs, invoices, "Manage billing" (Stripe Customer Portal) and the
// plan picker (Stripe Checkout) for organisations without a live subscription. Owners manage
// billing (studio:billing:manage); everyone else sees the page read-only with "ask an owner".
// Data: GET /billing, /billing/plans, /billing/invoices, /usage.

type Billing = BillingResponse['billing'];

export type PlanStatus = 'trialing' | 'active' | 'past_due' | 'read_only' | 'cancelling' | 'none';

const STATUS_TONE: Record<PlanStatus, Tone> = {
  trialing: 'live',
  active: 'good',
  past_due: 'warn',
  read_only: 'bad',
  cancelling: 'warn',
  none: 'neutral',
};

const DAY_MS = 86_400_000;

export function planStatus(billing: Pick<Billing, 'entitlements' | 'subscription'>): PlanStatus {
  const { entitlements: e, subscription: sub } = billing;
  if (e.access === 'none') return 'none';
  if (e.access === 'read_only') return 'read_only';
  const status = sub?.status ?? e.subscriptionStatus;
  if (status === 'past_due') return 'past_due';
  if (sub?.cancelAtPeriodEnd) return 'cancelling';
  if (status === 'trialing' || e.source === 'trial') return 'trialing';
  return 'active';
}

const BANNERS = {
  checkout: { success: 'checkoutSuccess', cancelled: 'checkoutCancelled' },
  topup: { success: 'topupSuccess', cancelled: 'topupCancelled' },
} as const;

function ReturnBanner() {
  const t = useTranslations('billing.banners');
  const params = useSearchParams();
  const [dismissed, setDismissed] = useState(false);
  const checkout = params?.get('checkout');
  const topup = params?.get('topup');
  const key =
    checkout === 'success' || checkout === 'cancelled'
      ? BANNERS.checkout[checkout]
      : topup === 'success' || topup === 'cancelled'
        ? BANNERS.topup[topup]
        : null;
  if (!key || dismissed) return null;
  const good = key.endsWith('Success');
  return (
    <div
      role="status"
      className={
        good
          ? 'mb-6 flex items-start gap-3 rounded-xl border border-success/40 bg-success/10 p-4 text-sm'
          : 'mb-6 flex items-start gap-3 rounded-xl border border-border bg-muted/50 p-4 text-sm'
      }
    >
      <p className="flex-1">{t(key)}</p>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('dismiss')}
        onClick={() => setDismissed(true)}
      >
        <X />
      </Button>
    </div>
  );
}

function StatusDetail({ billing, status }: { billing: Billing; status: PlanStatus }) {
  const t = useTranslations('billing.plan');
  const f = useFormat();
  const sub = billing.subscription;
  const date = (iso: string | null | undefined) => f.date(iso, { dateStyle: 'long' });
  switch (status) {
    case 'trialing': {
      const end = sub?.trialEnd ?? billing.entitlements.trial?.endsAt ?? null;
      return end ? <p>{t('trialEnds', { date: date(end) })}</p> : null;
    }
    case 'active':
      return sub?.currentPeriodEnd ? (
        <p>{t('renews', { date: date(sub.currentPeriodEnd) })}</p>
      ) : null;
    case 'cancelling':
      return sub?.currentPeriodEnd ? (
        <p>{t('cancelsOn', { date: date(sub.currentPeriodEnd) })}</p>
      ) : null;
    case 'past_due': {
      const grace = billing.entitlements.graceUntil;
      if (!grace) return null;
      const days = Math.max(0, Math.ceil((Date.parse(grace) - Date.now()) / DAY_MS));
      return (
        <p>
          {t('pastDue', { date: date(grace) })}{' '}
          <strong className="font-semibold">{t('graceLeft', { days })}</strong>
        </p>
      );
    }
    case 'read_only':
      return <p>{t('readOnly')}</p>;
    case 'none':
      return <p>{t('none')}</p>;
  }
}

function PlanSummary({
  billing,
  pending,
  onPortal,
}: {
  billing: Billing;
  pending: string | null;
  onPortal: () => void;
}) {
  const t = useTranslations('billing.plan');
  const tTier = useTranslations('shell.usage.tiers');
  const status = planStatus(billing);
  const interval = billing.subscription?.interval;
  const canPortal = billing.canManage && billing.hasBillingAccount && billing.checkoutEnabled;
  return (
    <Section title={t('title')}>
      <div className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-3xl leading-none">
            {status === 'none'
              ? t('noPlan')
              : t('tierName', { tier: tTier(billing.entitlements.tier) })}
          </p>
          <StateBadge label={t(`status.${status}`)} tone={STATUS_TONE[status]} />
        </div>
        <div className="grid gap-1 text-muted-foreground">
          <StatusDetail billing={billing} status={status} />
          {(interval === 'month' || interval === 'year') && <p>{t(`interval.${interval}`)}</p>}
          {billing.entitlements.source === 'admin' && <p>{t('adminSource')}</p>}
        </div>
        {canPortal && (
          <div className="grid gap-2">
            <div>
              <Button onClick={onPortal} disabled={pending !== null}>
                {pending === 'portal' ? <Loader2 className="animate-spin" /> : <CreditCard />}
                {t('manage')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('manageHelp')}</p>
          </div>
        )}
        {!billing.canManage && <p className="text-muted-foreground">{t('askOwner')}</p>}
      </div>
    </Section>
  );
}

function PlanPicker({
  billing,
  plans,
  pending,
  onChoose,
}: {
  billing: Billing;
  plans: PlansResponse | undefined;
  pending: string | null;
  onChoose: (intent: CheckoutIntent, pendingKey: string) => void;
}) {
  const t = useTranslations('billing.picker');
  const tPlan = useTranslations('billing.plan');
  const tTier = useTranslations('shell.usage.tiers');
  const [interval, setBillingInterval] = useState<BillingInterval>('month');
  const selfServe = (plans?.pricing.plans ?? []).filter((p) => p.selfServe);
  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={<IntervalToggle value={interval} onChange={setBillingInterval} />}
    >
      {!billing.checkoutEnabled && (
        <p className="mb-4 text-sm text-muted-foreground">{tPlan('checkoutUnavailable')}</p>
      )}
      {!plans ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <PlanCards
          plans={selfServe}
          interval={interval}
          cta={(plan) => {
            const tier = plan.tier as SelfServeTier;
            const key = `plan-${tier}`;
            const trial = plan.trialDays > 0 && billing.trialEligible;
            return (
              <Button
                className="w-full"
                variant={trial ? 'default' : 'outline'}
                disabled={
                  pending !== null ||
                  !billing.checkoutEnabled ||
                  plan.prices[interval]?.unitAmountPence == null
                }
                onClick={() => onChoose({ kind: 'subscription', tier, interval }, key)}
              >
                {pending === key && <Loader2 className="animate-spin" />}
                {trial ? t('trial') : t('choose', { tier: tTier(tier) })}
              </Button>
            );
          }}
        />
      )}
      {pending?.startsWith('plan-') && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t('redirecting')}
        </p>
      )}
    </Section>
  );
}

export function BillingScreen() {
  const t = useTranslations('billing');
  const res = useApi<BillingResponse>('/billing');
  const plans = useApi<PlansResponse>('/billing/plans');
  const { pending, checkout, portal } = useBillingActions({ onConflict: () => void res.mutate() });
  // The settings tabs, like the organisation, members and audit screens.
  const header = (
    <>
      <PageHeader
        eyebrow={t('header.eyebrow')}
        title={t('header.title')}
        description={t('header.description')}
      />
      <SettingsNav />
    </>
  );

  if (res.error instanceof ApiError && res.error.status === 501)
    return (
      <>
        {header}
        <EmptyState
          icon={<CreditCard className="size-8" strokeWidth={1.5} />}
          title={t('notEnabled.title')}
          description={t('notEnabled.body')}
        />
      </>
    );
  if (res.error)
    return (
      <>
        {header}
        <ErrorState error={res.error} onRetry={() => void res.mutate()} />
      </>
    );
  if (!res.data)
    return (
      <>
        {header}
        <Skeleton aria-label={t('loading')} className="h-64 rounded-xl" />
      </>
    );

  const billing = res.data.billing;
  const { source } = billing.entitlements;
  const showPicker =
    billing.canManage &&
    !isLiveSubscription(billing.subscription?.status) &&
    source !== 'admin' &&
    source !== 'core';
  return (
    <>
      {header}
      <ReturnBanner />
      {/* minmax(0,1fr): the invoice table scrolls inside its section instead of widening the
          page on phones. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <PlanSummary billing={billing} pending={pending} onPortal={() => void portal()} />
        {showPicker && (
          <PlanPicker
            billing={billing}
            plans={plans.data}
            pending={pending}
            onChoose={(intent, key) => void checkout(intent, key)}
          />
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
          <UsageSection billing={billing} />
          <TopUpsSection
            billing={billing}
            pricing={plans.data?.pricing}
            pending={pending}
            onBuy={(intent, key) => void checkout(intent, key)}
          />
        </div>
        <InvoicesSection enabled={billing.hasBillingAccount && billing.checkoutEnabled} />
      </div>
    </>
  );
}
