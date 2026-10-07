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
import type { UsageResponse } from '../usage-meter';
import {
  AllowanceSection,
  ChannelsSection,
  InvoicesSection,
  TopUpsSection,
  UsageSection,
} from './billing-sections';
import { ChannelPicker, choiceFromParams, type ChannelChoice } from './channel-picker';
import { CancelSection, ChangePlanSection } from './plan-change-section';
import {
  isLiveSubscription,
  type BillingResponse,
  type PlansResponse,
  type PricingView,
} from './types';
import { useBillingActions, type CheckoutIntent } from './use-billing-actions';

// Phase 18 §3 / 21.5 "Your plan" (/settings/billing) — one page for the per-channel plan: the
// channels, how often you pay, the price, the renewal date, videos used against the allowance and
// pack videos left; change channels or the period with a preview of the new price and when it
// applies (upgrades now with proration, downgrades at the end of the period); buy HD video packs;
// cancel and resume; the connected channels; seats, businesses and storage; and, through the
// Stripe Customer Portal, the payment method and invoices only. Organisations without a plan
// choose one here (Stripe Checkout). Owners manage it (studio:billing:manage); everyone else sees
// it read-only with "ask an owner". Data: GET /billing, /billing/plans, /billing/invoices, /usage,
// /billing/plan/preview. No generation cost is ever shown.

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
  status,
  pending,
  onKeepCurrent,
}: {
  billing: Billing;
  status: PlanStatus;
  pending: string | null;
  onKeepCurrent: () => void;
}) {
  const t = useTranslations('billing.plan');
  const tYour = useTranslations('billing.yourPlan.summary');
  const tPlan = useTranslations('channelPlan');
  const f = useFormat();
  const plan = billing.plan;
  const scheduled = plan?.pending;
  return (
    <Section title={tYour('title')}>
      <div className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-3xl leading-none">
            {status === 'none' || !plan
              ? t('noPlan')
              : tYour('headline', { count: plan.channels, period: plan.interval })}
          </p>
          <StateBadge label={t(`status.${status}`)} tone={STATUS_TONE[status]} />
        </div>
        {plan && plan.pricePerPeriodPence !== null && status !== 'none' && (
          <p className="text-base">
            {tPlan(`total.${plan.interval}`, { amount: f.pence(plan.pricePerPeriodPence) })}{' '}
            <span className="text-muted-foreground">· {tPlan('exclVat')}</span>
          </p>
        )}
        <div className="grid gap-1 text-muted-foreground">
          <StatusDetail billing={billing} status={status} />
          {plan?.legacy && <p>{tYour('legacy')}</p>}
          {billing.entitlements.source === 'admin' && <p>{t('adminSource')}</p>}
        </div>
        {scheduled && (
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p>
              {tYour('pending', {
                date: f.date(scheduled.effectiveAt, { dateStyle: 'long' }),
                count: scheduled.channels,
                period: scheduled.interval ?? plan?.interval ?? 'month',
              })}
            </p>
            {billing.canManage && (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={onKeepCurrent}
              >
                {pending === 'keep' && <Loader2 className="animate-spin" />}
                {tYour('keepCurrent')}
              </Button>
            )}
          </div>
        )}
        {plan?.paymentPending && (
          <p role="alert" className="rounded-lg border border-warning/50 bg-warning/10 p-3">
            {tYour('paymentPending')}
          </p>
        )}
        {!billing.canManage && <p className="text-muted-foreground">{t('askOwner')}</p>}
      </div>
    </Section>
  );
}

/** No plan yet: choose channels and how often to pay, then Stripe Checkout. */
function ChoosePlan({
  billing,
  pricing,
  pending,
  onChoose,
}: {
  billing: Billing;
  pricing: PricingView | undefined;
  pending: string | null;
  onChoose: (intent: CheckoutIntent, pendingKey: string) => void;
}) {
  const t = useTranslations('billing.picker');
  const tPlan = useTranslations('billing.plan');
  const params = useSearchParams();
  const [choice, setChoice] = useState<ChannelChoice>(() =>
    choiceFromParams(params, { channels: 1, interval: 'month' }, 6),
  );
  const trial = billing.trialEligible && (pricing?.trial.days ?? 0) > 0;
  const unit = pricing?.intervals.find((i) => i.interval === choice.interval)?.unitAmountPence;
  return (
    <Section title={t('title')} description={t('description')}>
      {!billing.checkoutEnabled && (
        <p className="mb-4 text-sm text-muted-foreground">{tPlan('checkoutUnavailable')}</p>
      )}
      {!pricing ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <div className="grid gap-6">
          <ChannelPicker id="choose-plan" value={choice} onChange={setChoice} pricing={pricing} />
          {trial && (
            <p className="text-sm text-muted-foreground">
              {t('trialNote', { days: pricing.trial.days, videos: pricing.trial.videos })}
            </p>
          )}
          <div>
            <Button
              className="w-full sm:w-auto"
              disabled={pending !== null || !billing.checkoutEnabled || unit == null}
              onClick={() => onChoose({ kind: 'channels', ...choice }, 'plan')}
            >
              {pending === 'plan' && <Loader2 className="animate-spin" />}
              {trial ? t('trial') : t('subscribe')}
            </Button>
          </div>
          {pending === 'plan' && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('redirecting')}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/** Payment method and invoices live in Stripe's portal (21.5: nothing else does). */
function BillingDetails({
  billing,
  pending,
  onPortal,
}: {
  billing: Billing;
  pending: string | null;
  onPortal: () => void;
}) {
  const t = useTranslations('billing.plan');
  const canPortal = billing.canManage && billing.hasBillingAccount && billing.checkoutEnabled;
  if (!canPortal) return null;
  return (
    <Section title={t('detailsTitle')} description={t('manageHelp')}>
      <div>
        <Button variant="outline" onClick={onPortal} disabled={pending !== null}>
          {pending === 'portal' ? <Loader2 className="animate-spin" /> : <CreditCard />}
          {t('manage')}
        </Button>
      </div>
    </Section>
  );
}

function changeBlockedReason(
  billing: Billing,
  status: PlanStatus,
  t: (key: 'managedByStaff' | 'blockedCancelling' | 'blockedPayment') => string,
): string | null {
  if (billing.plan?.source === 'admin') return t('managedByStaff');
  if (status === 'cancelling') return t('blockedCancelling');
  if (status === 'past_due' || status === 'read_only') return t('blockedPayment');
  return null;
}

export function BillingScreen() {
  const t = useTranslations('billing');
  const tChange = useTranslations('billing.yourPlan.change');
  const res = useApi<BillingResponse>('/billing');
  const plans = useApi<PlansResponse>('/billing/plans');
  const usage = useApi<UsageResponse>('/usage');
  const refresh = () => {
    void res.mutate();
    void usage.mutate();
  };
  const { pending, checkout, portal, changePlan, cancelPlan, resumePlan, keepCurrentPlan } =
    useBillingActions({
      onConflict: () => void res.mutate(),
      onChanged: refresh,
    });
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
          media={<CreditCard className="size-8" strokeWidth={1.5} />}
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
  const status = planStatus(billing);
  const { source } = billing.entitlements;
  const live = isLiveSubscription(billing.subscription?.status);
  const showChoose = billing.canManage && !live && source !== 'admin' && source !== 'core';
  return (
    <>
      {header}
      <ReturnBanner />
      {/* minmax(0,1fr): the invoice table scrolls inside its section instead of widening the
          page on phones. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <PlanSummary
          billing={billing}
          status={status}
          pending={pending}
          onKeepCurrent={() => void keepCurrentPlan()}
        />
        {showChoose && (
          <ChoosePlan
            billing={billing}
            pricing={plans.data?.pricing}
            pending={pending}
            onChoose={(intent, key) => void checkout(intent, key)}
          />
        )}
        {billing.plan && status !== 'none' && <AllowanceSection billing={billing} />}
        {live && billing.canManage && billing.plan && plans.data && (
          <ChangePlanSection
            plan={billing.plan}
            pricing={plans.data.pricing}
            pending={pending}
            disabledReason={changeBlockedReason(billing, status, (key) => tChange(key))}
            onChange={changePlan}
          />
        )}
        <ChannelsSection billing={billing} />
        <TopUpsSection
          billing={billing}
          pricing={plans.data?.pricing}
          pending={pending}
          onBuy={(intent, key) => void checkout(intent, key)}
        />
        {live && billing.canManage && billing.plan?.source !== 'admin' && (
          <CancelSection
            cancelling={Boolean(billing.subscription?.cancelAtPeriodEnd)}
            endsAt={
              billing.subscription?.trialEnd ?? billing.subscription?.currentPeriodEnd ?? null
            }
            pending={pending}
            onCancel={cancelPlan}
            onResume={resumePlan}
          />
        )}
        <UsageSection billing={billing} />
        <BillingDetails billing={billing} pending={pending} onPortal={() => void portal()} />
        <InvoicesSection enabled={billing.hasBillingAccount && billing.checkoutEnabled} />
      </div>
    </>
  );
}
