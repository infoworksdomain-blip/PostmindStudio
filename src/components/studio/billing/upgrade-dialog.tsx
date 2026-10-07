'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
import { StudioCapability } from '@/lib/rbac';
import { subscribeUpgrade, type UpgradeEvent } from '@/lib/client/upgrade-events';
import { channelLabel, channelList } from './channel-labels';
import type { BillingResponse } from './types';
import { useBillingActions } from './use-billing-actions';
import { useCan } from '../use-can';
import { useMe } from '../account/use-me';

// Phase 18 §3 / §P.4 / 21.5 — the global upgrade dialog. api() emits every plan / billing block
// on the upgrade bus (src/lib/client/upgrade-events.ts); this host (mounted once in AppShell)
// opens. 21.5: there is one per-channel plan, so no tier is ever named:
//   403 plan_tier        → "not included in your plan" (an internal-tier feature)
//   403 quota_exceeded   → add a channel (Your plan) or buy a video pack
//   403 channel_limit    → add a channel to publish to this platform
//   402 plan_required    → choose a plan (/settings/billing)
//   402 billing_required → "Update payment method" (Customer Portal)
// Only owners (canManage) get the Stripe button; everyone else is asked to find an owner.

type Billing = BillingResponse['billing'];

function UpgradeActions({
  event,
  billing,
  onClose,
}: {
  event: UpgradeEvent;
  billing: Billing | undefined;
  onClose: () => void;
}) {
  const t = useTranslations('upgrade');
  const { pending, portal } = useBillingActions();
  const owner = Boolean(billing?.canManage && billing.checkoutEnabled);
  const link = (href: string, label: string, variant: 'default' | 'outline' = 'default') => (
    <Button asChild variant={variant}>
      <Link href={href} onClick={onClose}>
        {label}
      </Link>
    </Button>
  );
  return (
    <DialogFooter>
      <Button variant="ghost" onClick={onClose}>
        {t('actions.notNow')}
      </Button>
      {event.code === 'plan_required' && link('/settings/billing', t('actions.choosePlan'))}
      {event.code === 'quota_exceeded' &&
        !isSeatLimit(event) &&
        link('/settings/billing#topups', t('actions.buyPack'), 'outline')}
      {(event.code === 'quota_exceeded' || event.code === 'channel_limit') &&
        !isSeatLimit(event) &&
        link('/settings/billing#change', t('actions.addChannel'))}
      {isSeatLimit(event) && link('/settings/members', t('actions.manageMembers'))}
      {event.code === 'plan_tier' && link('/pricing', t('actions.viewPlan'), 'outline')}
      {event.code === 'billing_required' && owner && (
        <Button
          onClick={() => void portal()}
          disabled={pending !== null}
          loading={pending === 'portal'}
        >
          {t('actions.updatePayment')}
        </Button>
      )}
    </DialogFooter>
  );
}

/** A refused invitation because every seat is used: a plan limit, not the monthly allowance. */
function isSeatLimit(event: UpgradeEvent): boolean {
  return event.code === 'quota_exceeded' && event.details?.reason === 'seat_limit';
}

const COPY = {
  plan_tier: 'planTier',
  quota_exceeded: 'quota',
  channel_limit: 'channelLimit',
  plan_required: 'planRequired',
  billing_required: 'billingRequired',
} as const;

function ChannelLimitBody({ event }: { event: UpgradeEvent }) {
  const t = useTranslations('upgrade.channelLimit');
  const channels = Number(event.details?.channels ?? 0);
  const platform = typeof event.details?.platform === 'string' ? event.details.platform : '';
  const allowed = Array.isArray(event.details?.allowedPlatforms)
    ? event.details.allowedPlatforms.filter((p): p is string => typeof p === 'string')
    : [];
  return (
    <p>
      {t('body', {
        count: channels,
        list: channelList(allowed),
        platform: channelLabel(platform),
      })}
    </p>
  );
}

export function UpgradeDialog({ event, onClose }: { event: UpgradeEvent; onClose: () => void }) {
  const t = useTranslations('upgrade');
  // Billing details are only readable with studio:billing:read (owner, admin); others are told to
  // ask an owner without a request the API would refuse.
  const meKnown = Boolean(useMe().data);
  const mayReadBilling = useCan(StudioCapability.BillingRead);
  const billing = useApi<BillingResponse>(mayReadBilling ? '/billing' : null, undefined, {
    shouldRetryOnError: false,
  });
  const copy = isSeatLimit(event) ? 'seatLimit' : COPY[event.code];
  const data = billing.data?.billing;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t(`${copy}.title`)}</DialogTitle>
          <DialogDescription asChild>
            <div className="grid gap-2">
              {copy === 'channelLimit' ? (
                <ChannelLimitBody event={event} />
              ) : (
                <p>{t(`${copy}.body`)}</p>
              )}
              {copy === 'quota' && <p>{t('quota.quickPosts')}</p>}
              {((data && !data.canManage) || (meKnown && !mayReadBilling)) &&
                event.code !== 'plan_required' && <p>{t('askOwner')}</p>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <UpgradeActions event={event} billing={data} onClose={onClose} />
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
      key={`${event.code}-${String(event.details?.requiredTier ?? event.details?.platform ?? '')}`}
      event={event}
      onClose={() => setEvent(null)}
    />
  );
}

/** "Add a channel" and "Buy a video pack" on the usage banner (usage-meter.tsx). */
export function UsageBannerActions({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('upgrade.actions');
  // compact: the app shell's one-line notice strip (25.4), smaller buttons and no top margin.
  const size = compact ? 'xs' : 'sm';
  return (
    <div className={compact ? 'flex flex-wrap gap-2' : 'mt-3 flex flex-wrap gap-2'}>
      {/* In the calm strip both actions are quiet; the full banner keeps the primary one. */}
      <Button asChild size={size} variant={compact ? 'outline' : 'default'}>
        <Link href="/settings/billing#change">{t('addChannel')}</Link>
      </Button>
      <Button asChild size={size} variant="outline">
        <Link href="/settings/billing#topups">{t('buyPack')}</Link>
      </Button>
    </div>
  );
}
