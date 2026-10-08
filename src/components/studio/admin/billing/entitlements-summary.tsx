'use client';

import { useTranslations } from 'next-intl';
import { useFormat } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { meterFillClass } from '../../usage-meter';
import {
  isSubscriptionStatus,
  PLAN_TIERS,
  type AdminEntitlementsResponse,
  type ChannelInterval,
  type PlanTier,
} from '../../billing/types';

// Phase 18 §P.3 / 20.27 — what staff see before changing a plan: the effective tier, access and
// source, the channel plan (21.5: channels, interval, set by staff or Stripe), the trial (state,
// dates, AI cost so far against its £15 total), the stored row, the current override and the
// subscriptions (with their channels, the item quantity).

export type EntitlementView = AdminEntitlementsResponse['entitlements'];
export type Access = 'full' | 'read_only' | 'none';

export const ACCESS: readonly Access[] = ['full', 'read_only', 'none'];
const SOURCES = ['stripe', 'trial', 'admin', 'core', 'none'] as const;
type Source = (typeof SOURCES)[number];
const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);
export const isAccess = (s: string): s is Access => (ACCESS as readonly string[]).includes(s);

/** 21.5: the per-channel plan's billing intervals (staff label them weekly / monthly / yearly). */
export const CHANNEL_INTERVALS = [
  'week',
  'month',
  'year',
] as const satisfies readonly ChannelInterval[];
export const isChannelInterval = (s: string | null | undefined): s is ChannelInterval =>
  typeof s === 'string' && (CHANNEL_INTERVALS as readonly string[]).includes(s);

/** 21.5: "3 channels · monthly", "set by staff" / "from Stripe". */
type ChannelPlanView = NonNullable<EntitlementView['effective']['channelPlan']>;

function ChannelPlanValue({ plan }: { plan: ChannelPlanView }) {
  const t = useTranslations('billing.admin.entitlements');
  return (
    <span data-testid="channel-plan">
      <span className="font-medium">
        {t('channelPlanValue', { count: plan.channels, interval: plan.interval })}
      </span>{' '}
      <span className="text-muted-foreground">
        {t('channelPlanSource', { source: plan.source })}
      </span>
    </span>
  );
}

/** A trial that has not been ended by staff and whose Stripe trial is still on. */
export function trialCanEnd(view: EntitlementView): boolean {
  return view.trial?.state === 'running' || view.trial?.state === 'overridden';
}

function TrialBlock({ trial }: { trial: NonNullable<EntitlementView['trial']> }) {
  const t = useTranslations('billing.admin.entitlements.trial');
  const f = useFormat();
  const spentShare = trial.totalCostCapPence > 0 ? trial.spentPence / trial.totalCostCapPence : 0;
  return (
    <div className="grid gap-1" data-testid="trial-summary">
      <h3 className="font-medium">{t('title')}</h3>
      <p className={cn('font-medium', trial.state === 'running' && 'text-warning-foreground')}>
        {trial.state === 'ended'
          ? t('state.ended', { date: f.date(trial.endedAt) })
          : t(`state.${trial.state}`)}
      </p>
      <p className="text-muted-foreground">
        {t('dates', {
          start: f.date(trial.startedAt),
          end: trial.endsAt ? f.date(trial.endsAt) : t('noEnd'),
        })}
      </p>
      <p className="text-muted-foreground">
        {t('spent', {
          spent: f.pence(trial.spentPence),
          total: f.pence(trial.totalCostCapPence),
          daily: f.pence(trial.dailyCostCapPence),
        })}
      </p>
      {trial.state !== 'ended' && trial.state !== 'over' && (
        <div
          role="meter"
          aria-label={t('meterAria')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, spentShare) * 100)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full', meterFillClass(spentShare * 100))}
            style={{ width: `${Math.min(100, spentShare * 100)}%` }}
          />
        </div>
      )}
      {trial.state === 'running' && (
        <p className="text-xs text-muted-foreground">{t('capsNote')}</p>
      )}
    </div>
  );
}

export function EntitlementsSummary({ view }: { view: EntitlementView }) {
  const t = useTranslations('billing.admin.entitlements');
  const tTier = useTranslations('shell.usage.tiers');
  const tStatus = useTranslations('billing.subscriptionStatus');
  const f = useFormat();
  const intervalName = (interval: string | null) =>
    isChannelInterval(interval) ? t(`intervalValues.${interval}`) : (interval ?? '—');
  const e = view.effective;
  const access = (a: string) => (isAccess(a) ? t(`accessValues.${a}`) : a);
  const source = (s: string) => (isSource(s) ? t(`sourceValues.${s}`) : s);
  const tierName = (tier: string | null) =>
    tier && (PLAN_TIERS as readonly string[]).includes(tier)
      ? tTier(tier as PlanTier)
      : (tier ?? '—');
  return (
    <div className="grid gap-4 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('tier')}</dt>
        <dd className="font-medium">{tierName(e.tier)}</dd>
        <dt className="text-muted-foreground">{t('access')}</dt>
        <dd>{access(e.access)}</dd>
        <dt className="text-muted-foreground">{t('source')}</dt>
        <dd>{source(e.source)}</dd>
        <dt className="text-muted-foreground">{t('channelPlan')}</dt>
        <dd>
          {e.channelPlan ? (
            <ChannelPlanValue plan={e.channelPlan} />
          ) : (
            <span className="text-muted-foreground">{t('noChannelPlan')}</span>
          )}
        </dd>
        {e.graceUntil && (
          <>
            <dt className="text-muted-foreground">{t('graceUntil')}</dt>
            <dd>{f.date(e.graceUntil)}</dd>
          </>
        )}
      </dl>
      {view.trial && <TrialBlock trial={view.trial} />}
      <div className="grid gap-1">
        <h3 className="font-medium">{t('stored')}</h3>
        <p className="text-muted-foreground">
          {view.stored
            ? t('storedSummary', {
                tier: tierName(view.stored.tier),
                access: access(view.stored.access),
                source: source(view.stored.source),
                when: f.relative(view.stored.updatedAt),
              })
            : t('noStored')}
        </p>
      </div>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('override')}</h3>
        {view.admin ? (
          <div className="grid gap-0.5 text-muted-foreground">
            <p>{t('overrideReason', { reason: view.admin.reason })}</p>
            <p>{t('overrideSetAt', { when: f.relative(view.admin.setAt) })}</p>
            {view.admin.channels != null && (
              <p>{t('overrideChannels', { count: view.admin.channels })}</p>
            )}
            {view.admin.interval && (
              <p>{t('overrideInterval', { interval: view.admin.interval })}</p>
            )}
            <p>
              {view.admin.expiresAt
                ? t('expires', { date: f.date(view.admin.expiresAt) })
                : t('noExpiry')}
            </p>
            {view.admin.monthlyPricePence != null && (
              <p>{t('overridePrice', { amount: f.pence(view.admin.monthlyPricePence) })}</p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">{t('noOverride')}</p>
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('subscriptions')}</h3>
        {view.subscriptions.length === 0 ? (
          <p className="text-muted-foreground">{t('noSubscriptions')}</p>
        ) : (
          <ul className="grid gap-1">
            {view.subscriptions.map((s) => (
              <li key={s.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {isSubscriptionStatus(s.status) ? tStatus(s.status) : s.status}
                </span>{' '}
                {t('subscriptionChannelLine', {
                  tier: tierName(s.tier),
                  count: s.quantity,
                  interval: intervalName(s.interval),
                  date: f.date(s.currentPeriodEnd, { dateStyle: 'medium' }),
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
