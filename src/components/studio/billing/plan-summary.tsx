'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useFormat, type Tone } from '@/lib/client/format';
import { Section, StateBadge } from '../primitives';
import type { QuotaMeterView, UsageResponse } from '../usage-meter';
import type { BillingResponse } from './types';

// BACKLOG 25.12 — the top of Your plan: what you have (channels and how often you pay), its state,
// the price, the date that matters next, and what is left to use this period, as one scannable
// panel. A zero allowance reads "0 of 8" — it is never hidden.

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

/**
 * Videos left this period (quick posts count ¼, 23.3: exact from the quarters when present), never
 * below zero; null when the allowance is unlimited.
 */
export function allowanceLeft(meter: QuotaMeterView): number | null {
  if (meter.limit === null) return null;
  if (typeof meter.usedQuarters === 'number' && typeof meter.limitQuarters === 'number')
    return Math.max(0, meter.limitQuarters - meter.usedQuarters) / 4;
  return Math.max(0, meter.limit - meter.used);
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-base font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Price, videos left this period and pack videos left. */
function PlanFacts({ billing, usage }: { billing: Billing; usage?: UsageResponse['usage'] }) {
  const t = useTranslations('billing.yourPlan.summary');
  const tPlan = useTranslations('channelPlan');
  const f = useFormat();
  const plan = billing.plan;
  const meter = usage?.videos.short;
  const left = meter ? allowanceLeft(meter) : null;
  const num = (n: number) => f.number(n, { maximumFractionDigits: 2 });
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
      {plan && plan.pricePerPeriodPence !== null && (
        <Fact label={t('price')}>
          {tPlan(`total.${plan.interval}`, { amount: f.pence(plan.pricePerPeriodPence) })}
          <span className="ms-1.5 text-xs font-normal text-muted-foreground">
            {tPlan('exclVat')}
          </span>
        </Fact>
      )}
      {meter && left !== null && meter.limit !== null && (
        <Fact label={t('videosLeft', { period: usage?.period ?? 'month' })}>
          {t('leftOf', { left: num(left), limit: num(meter.limit) })}
        </Fact>
      )}
      <Fact label={t('packVideos')}>{num(billing.credits.short)}</Fact>
    </dl>
  );
}

export function PlanSummary({
  billing,
  status,
  usage,
  pending,
  onKeepCurrent,
}: {
  billing: Billing;
  status: PlanStatus;
  usage?: UsageResponse['usage'];
  pending: string | null;
  onKeepCurrent: () => void;
}) {
  const t = useTranslations('billing.plan');
  const tYour = useTranslations('billing.yourPlan.summary');
  const f = useFormat();
  const plan = billing.plan;
  const scheduled = plan?.pending;
  return (
    <Section title={tYour('title')} variant="panel">
      <div className="grid gap-5 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-2xl leading-tight md:text-3xl">
            {status === 'none' || !plan
              ? t('noPlan')
              : tYour('headline', { count: plan.channels, period: plan.interval })}
          </p>
          <StateBadge label={t(`status.${status}`)} tone={STATUS_TONE[status]} />
        </div>
        {plan && status !== 'none' && <PlanFacts billing={billing} usage={usage} />}
        <div className="grid gap-1 text-foreground-secondary">
          <StatusDetail billing={billing} status={status} />
          {plan?.legacy && <p>{tYour('legacy')}</p>}
          {billing.entitlements.source === 'admin' && <p>{t('adminSource')}</p>}
        </div>
        {scheduled && (
          <div className="rounded-field bg-surface-raised p-3">
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
                loading={pending === 'keep'}
              >
                {tYour('keepCurrent')}
              </Button>
            )}
          </div>
        )}
        {plan?.paymentPending && (
          <p role="alert" className="rounded-field bg-warning-soft p-3 text-warning-foreground">
            {tYour('paymentPending')}
          </p>
        )}
        {!billing.canManage && <p className="text-muted-foreground">{t('askOwner')}</p>}
      </div>
    </Section>
  );
}
