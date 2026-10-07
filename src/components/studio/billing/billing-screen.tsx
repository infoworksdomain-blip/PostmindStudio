'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreditCard, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, useApi } from '@/lib/client/api';
import { EmptyState, ErrorState, PageHeader, Section } from '../primitives';
import type { UsageResponse } from '../usage-meter';
import { AllowanceSection, ChannelsSection, TopUpsSection, UsageSection } from './billing-sections';
import { PaymentSection } from './payment-section';
import { planStatus, PlanSummary, type PlanStatus } from './plan-summary';
import { ChannelPicker, choiceFromParams, type ChannelChoice } from './channel-picker';
import { CancelSection, ChangePlanSection } from './plan-change-section';
import {
  isLiveSubscription,
  type BillingResponse,
  type PlansResponse,
  type PricingView,
} from './types';
import { useBillingActions, type CheckoutIntent } from './use-billing-actions';

// Phase 18 §3 / 21.5 "Your plan" (/settings/billing) — one page for the per-channel plan. 25.12
// reads it top to bottom: what you have (plan-summary.tsx), what you have used this period,
// payment method and invoices, changing the plan, video packs, the channels, team and storage, and
// cancelling last. Organisations without a plan choose one here (Stripe Checkout). Owners manage
// it (studio:billing:manage); everyone else sees it read-only with "ask an owner". Data: GET
// /billing, /billing/plans, /billing/invoices, /usage, /billing/plan/preview. No generation cost is
// ever shown, and no upgrade is pushed: the page answers questions, the upgrade dialog host stays.

type Billing = BillingResponse['billing'];

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
          ? 'mb-6 flex items-start gap-2.5 rounded-field bg-success-soft py-2.5 ps-3.5 pe-2 text-sm text-success-foreground'
          : 'mb-6 flex items-start gap-2.5 rounded-field bg-surface-raised py-2.5 ps-3.5 pe-2 text-sm text-foreground-secondary'
      }
    >
      <p className="flex-1 py-px leading-relaxed">{t(key)}</p>
      <IconButton size="icon-xs" label={t('dismiss')} onClick={() => setDismissed(true)}>
        <X />
      </IconButton>
    </div>
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
              loading={pending === 'plan'}
            >
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
  const tn = useTranslations('settingsNav');
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
  const header = (
    <PageHeader
      eyebrow={tn('title')}
      title={t('header.title')}
      description={t('header.description')}
    />
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
        <PlanSummary
          billing={billing}
          status={status}
          usage={usage.data?.usage}
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
        {billing.plan && status !== 'none' && (
          <AllowanceSection billing={billing} usage={usage.data?.usage} />
        )}
        <PaymentSection billing={billing} pending={pending} onPortal={() => void portal()} />
        {live && billing.canManage && billing.plan && plans.data && (
          <ChangePlanSection
            plan={billing.plan}
            pricing={plans.data.pricing}
            pending={pending}
            disabledReason={changeBlockedReason(billing, status, (key) => tChange(key))}
            onChange={changePlan}
          />
        )}
        <TopUpsSection
          billing={billing}
          pricing={plans.data?.pricing}
          pending={pending}
          onBuy={(intent, key) => void checkout(intent, key)}
        />
        <ChannelsSection billing={billing} />
        <UsageSection billing={billing} />
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
      </div>
    </>
  );
}
