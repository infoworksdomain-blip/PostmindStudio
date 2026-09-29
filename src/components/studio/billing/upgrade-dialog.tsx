'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApi } from '@/lib/client/api';
import { useFormat } from '@/lib/client/format';
import { subscribeUpgrade, type UpgradeEvent } from '@/lib/client/upgrade-events';
import {
  isLiveSubscription,
  isPlanTier,
  type BillingResponse,
  type PlanTier,
  type PlansResponse,
} from './types';
import { useBillingActions } from './use-billing-actions';

// Phase 18 §3 / §P.4 — the global upgrade dialog. api() emits every plan / billing block on the
// upgrade bus (src/lib/client/upgrade-events.ts); this host (mounted once in AppShell) opens:
//   403 plan_tier        → names details.requiredTier and its monthly price; "Upgrade" goes to
//                          Checkout (no subscription) or the Customer Portal (plan change)
//   403 quota_exceeded   → upgrade, or buy a top-up (/settings/billing#topups)
//   402 plan_required    → choose a plan (/settings/billing)
//   402 billing_required → "Update payment method" (Customer Portal)
// Only owners (canManage) get the Stripe buttons; everyone else is asked to find an owner.

type Billing = BillingResponse['billing'];

function PlanTierBody({
  tier,
  plans,
}: {
  tier: PlanTier | null;
  plans: PlansResponse | undefined;
}) {
  const t = useTranslations('upgrade.planTier');
  const tTier = useTranslations('shell.usage.tiers');
  const f = useFormat();
  if (!tier) return null;
  const name = tTier(tier);
  const amount = plans?.pricing.plans.find((p) => p.tier === tier)?.prices.month?.unitAmountPence;
  return (
    <>
      <p>{t('body', { tier: name })}</p>
      {tier === 'ENTERPRISE' ? (
        <p>{t('enterprise')}</p>
      ) : (
        amount != null && (
          <p className="font-medium">{t('price', { tier: name, amount: f.pence(amount) })}</p>
        )
      )}
    </>
  );
}

function UpgradeActions({
  event,
  billing,
  requiredTier,
  onClose,
}: {
  event: UpgradeEvent;
  billing: Billing | undefined;
  requiredTier: PlanTier | null;
  onClose: () => void;
}) {
  const t = useTranslations('upgrade');
  const { pending, checkout, portal } = useBillingActions();
  const owner = Boolean(billing?.canManage && billing.checkoutEnabled);
  const live = isLiveSubscription(billing?.subscription?.status);
  const spinner = (key: string) => pending === key && <Loader2 className="animate-spin" />;
  const link = (href: string, label: string, variant: 'default' | 'outline' = 'default') => (
    <Button asChild variant={variant}>
      <Link href={href} onClick={onClose}>
        {label}
      </Link>
    </Button>
  );

  const upgradeButton = () => {
    if (!owner) return null;
    if (live || event.code === 'billing_required')
      return (
        <Button onClick={() => void portal()} disabled={pending !== null}>
          {spinner('portal')}
          {event.code === 'billing_required' ? t('actions.updatePayment') : t('actions.upgrade')}
        </Button>
      );
    if (requiredTier && requiredTier !== 'ENTERPRISE')
      return (
        <Button
          onClick={() =>
            void checkout(
              { kind: 'subscription', tier: requiredTier, interval: 'month' },
              'upgrade',
            )
          }
          disabled={pending !== null}
        >
          {spinner('upgrade')}
          {t('actions.upgrade')}
        </Button>
      );
    return link('/settings/billing', t('actions.upgrade'));
  };

  return (
    <DialogFooter>
      <Button variant="ghost" onClick={onClose}>
        {t('actions.notNow')}
      </Button>
      {event.code === 'plan_required' && link('/settings/billing', t('actions.choosePlan'))}
      {event.code === 'quota_exceeded' &&
        link('/settings/billing#topups', t('actions.buyTopUp'), 'outline')}
      {event.code === 'plan_tier' &&
        requiredTier === 'ENTERPRISE' &&
        link('/pricing', t('actions.viewPlans'), 'outline')}
      {event.code !== 'plan_required' && upgradeButton()}
    </DialogFooter>
  );
}

const COPY = {
  plan_tier: 'planTier',
  quota_exceeded: 'quota',
  plan_required: 'planRequired',
  billing_required: 'billingRequired',
} as const;

export function UpgradeDialog({ event, onClose }: { event: UpgradeEvent; onClose: () => void }) {
  const t = useTranslations('upgrade');
  const tTier = useTranslations('shell.usage.tiers');
  const billing = useApi<BillingResponse>('/billing', undefined, { shouldRetryOnError: false });
  const plans = useApi<PlansResponse>(event.code === 'plan_tier' ? '/billing/plans' : null);
  const required = event.details?.requiredTier;
  const requiredTier = isPlanTier(required) ? required : null;
  const copy = COPY[event.code];
  const title =
    copy === 'planTier'
      ? requiredTier
        ? t('planTier.title', { tier: tTier(requiredTier) })
        : t('actions.upgrade')
      : t(`${copy}.title`);
  const data = billing.data?.billing;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2">
              {copy === 'planTier' ? (
                <PlanTierBody tier={requiredTier} plans={plans.data} />
              ) : (
                <p>{t(`${copy}.body`)}</p>
              )}
              {data && !data.canManage && event.code !== 'plan_required' && <p>{t('askOwner')}</p>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <UpgradeActions
          event={event}
          billing={data}
          requiredTier={requiredTier}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once in AppShell: opens the upgrade dialog for every plan / billing block. */
export function UpgradeDialogHost() {
  const [event, setEvent] = useState<UpgradeEvent | null>(null);
  useEffect(() => subscribeUpgrade(setEvent), []);
  if (!event) return null;
  return (
    <UpgradeDialog
      key={`${event.code}-${String(event.details?.requiredTier ?? '')}`}
      event={event}
      onClose={() => setEvent(null)}
    />
  );
}

/** "Upgrade" and "Buy top-up" on the usage banner (usage-meter.tsx). */
export function UsageBannerActions() {
  const t = useTranslations('upgrade.actions');
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button asChild size="sm">
        <Link href="/settings/billing">{t('upgrade')}</Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href="/settings/billing#topups">{t('buyTopUp')}</Link>
      </Button>
    </div>
  );
}
