'use client';

import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { BILLING_VIEWS, type BillingView } from '../admin-sections';
import { EntitlementsPanel } from './entitlements-panel';
import { SubscriptionRecords } from './subscription-records';
import { SubscriptionsPanel } from './subscriptions-panel';

// BACKLOG 25.13 — "Subscriptions & billing": the old Subscriptions tab and Billing tab overlapped
// (two subscription lists from two endpoints), so they are one section with three views, nothing
// dropped:
//   overview      — MRR, counts by tier and status, the list with tier / interval / MRR
//                   (GET /admin/billing/subscriptions, Phase 18 §P.4);
//   records       — the Stripe records: subscription ids, price lookup keys, grace periods
//                   (GET /admin/subscriptions, read-only, Phase 18 §3);
//   entitlements  — one organisation's entitlement override (Phase 18 §P.3).
// The view is in the URL (?view=) with the section.

export function AdminBillingTab({
  view,
  onViewChange,
}: {
  view: BillingView;
  onViewChange: (view: BillingView) => void;
}) {
  const t = useTranslations('admin.centre.billingViews');
  return (
    <div className="grid min-w-0 gap-8">
      <SegmentedControl
        label={t('label')}
        options={BILLING_VIEWS.map((v) => ({ value: v, label: t(v) }))}
        value={view}
        onChange={onViewChange}
        className="max-w-full flex-wrap"
      />
      {view === 'overview' && <SubscriptionsPanel />}
      {view === 'records' && <SubscriptionRecords />}
      {view === 'entitlements' && <EntitlementsPanel />}
    </div>
  );
}
